import { create } from 'zustand'
import type { CollectSite, Specimen } from '@/types'
import { db, deleteRow, loadAll, putRow, putRows } from '@/hooks/usePersistentStore'
import type { CodeRenameBlocked } from '@/utils/codec'
import { planSiteCodeRename } from '@/utils/codec'

/** 采集地保存结果：代码变更时附带标本编号迁移情况 */
export interface SiteSaveResult {
  /** 实际迁移了编号的标本数 */
  migrated: number
  /** 卡住的旧编号（非空时采集地与标本均未改动） */
  blocked: CodeRenameBlocked[]
}

export interface SiteState {
  rows: CollectSite[]
  loaded: boolean
  hydrate: () => Promise<void>
  /**
   * 保存采集地。若代码发生变更，会在同一事务内同步迁移该采集地已有标本的编号
   * （保留年份与流水号）：只有所有新编号都成功写入才保存采集地；
   * 一旦有编号卡住（旧编号无法解析 / 新编号重复），整笔放弃并返回 blocked。
   */
  save: (row: CollectSite) => Promise<SiteSaveResult>
  remove: (id: string) => Promise<void>
  /** 合并采集地：把 sourceId 下的标本全部改挂到 targetId，然后删除 source 记录 */
  mergeSite: (sourceId: string, targetId: string) => Promise<number>
}

export const siteStore = create<SiteState>((set, get) => ({
  rows: [],
  loaded: false,
  hydrate: async () => {
    const rows = await loadAll<CollectSite>(db.sites)
    rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
    set({ rows, loaded: true })
  },
  save: async (row) => {
    const previous = get().rows.find((item) => item.id === row.id)
    const codeChanged = previous !== undefined && previous.code.trim().toUpperCase() !== row.code.trim().toUpperCase()

    if (!codeChanged) {
      await putRow<CollectSite>(db.sites, row)
      await get().hydrate()
      return { migrated: 0, blocked: [] }
    }

    // 代码变更：先在内存中规划全部迁移，任何一条卡住都不开启写入
    const allSpecimens = await loadAll<Specimen>(db.specimens)
    const plan = planSiteCodeRename(row.id, row.code, allSpecimens)
    if (plan.blocked.length > 0) {
      return { migrated: 0, blocked: plan.blocked }
    }

    // 单事务：所有新编号先全部写入成功，采集地代码才随之保存；任一步失败整体回滚
    await db.transaction('rw', db.specimens, db.sites, async (tx) => {
      if (plan.updates.length > 0) {
        const migratedRows = plan.updates.map((update) => {
          const specimen = allSpecimens.find((item) => item.id === update.id)
          if (!specimen) throw new Error(`迁移失败：找不到标本 ${update.id}`)
          return { ...specimen, code: update.code }
        })
        await tx.table<Specimen, string>('specimens').bulkPut(migratedRows)
      }
      await tx.table<CollectSite, string>('sites').put(row)
    })

    await get().hydrate()
    return { migrated: plan.updates.length, blocked: [] }
  },
  remove: async (id) => {
    await deleteRow<CollectSite>(db.sites, id)
    await get().hydrate()
  },
  mergeSite: async (sourceId, targetId) => {
    const specimens = await loadAll<Specimen>(db.specimens)
    const moved = specimens.filter((item) => item.siteId === sourceId).map((item) => ({ ...item, siteId: targetId }))
    await putRows<Specimen>(db.specimens, moved)
    await deleteRow<CollectSite>(db.sites, sourceId)
    await get().hydrate()
    return moved.length
  }
}))
