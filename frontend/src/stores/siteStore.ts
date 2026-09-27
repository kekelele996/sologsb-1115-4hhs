import { create } from 'zustand'
import type { CollectSite, Specimen } from '@/types'
import { db, deleteRow, loadAll, putRow, putRows } from '@/hooks/usePersistentStore'
import { planCodeMigration } from '@/utils/codec'

/** 采集地保存结果：代码变更时会连带迁移该采集地已有标本编号 */
export type SaveSiteResult =
  | { ok: true; /** 本次连带迁移的标本数 */ migrated: number }
  | { ok: false; /** 旧编号拆不出年份/流水号 */ unparsable: string[]; /** 新编号与其他标本重复 */ conflicts: string[] }

export interface SiteState {
  rows: CollectSite[]
  loaded: boolean
  hydrate: () => Promise<void>
  /**
   * 保存采集地。若代码发生变化，会把该采集地已有标本编号一并迁移
   * （保留原年份与流水号）；存在无法解析的旧编号或新编号冲突时整体放弃，
   * 采集地与标本都不改动。
   */
  save: (row: CollectSite) => Promise<SaveSiteResult>
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
    const previous = await db.sites.get(row.id)
    const codeChanged = previous !== undefined && previous.code !== row.code

    // 代码未变（新建或仅改其他字段）：只写采集地本身
    if (!codeChanged) {
      await putRow<CollectSite>(db.sites, row)
      await get().hydrate()
      return { ok: true, migrated: 0 }
    }

    // 先规划迁移：任一编号卡住就整体放弃，采集地和标本都不动
    const specimens = await loadAll<Specimen>(db.specimens)
    const plan = planCodeMigration(specimens, row.id, row.code)
    if (plan.unparsable.length > 0 || plan.conflicts.length > 0) {
      return { ok: false, unparsable: plan.unparsable, conflicts: plan.conflicts }
    }

    // 同一事务写入全部新编号与采集地：任一失败整体回滚，只有全部成功才提交
    const migratedRows = plan.updates.map(({ specimen, nextCode }) => ({ ...specimen, code: nextCode }))
    await db.transaction('rw', db.specimens, db.sites, async () => {
      if (migratedRows.length > 0) {
        await db.specimens.bulkPut(migratedRows)
      }
      await db.sites.put(row)
    })

    await get().hydrate()
    return { ok: true, migrated: migratedRows.length }
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
