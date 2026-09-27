import type { Specimen, Storage } from '@/types'

/** 标本编号：采集地代码-年份-流水号，如 QLB-2026-0007 */
export function buildSpecimenCode(siteCode: string, year: number | string, serial: number): string {
  return `${siteCode.toUpperCase()}-${year}-${String(serial).padStart(4, '0')}`
}

/** 解析标本编号 */
export function parseSpecimenCode(code: string): { siteCode: string; year: string; serial: number } | null {
  const match = /^([A-Za-z0-9]+)-(\d{4})-(\d{3,5})$/.exec(code.trim())
  if (!match) return null
  return { siteCode: match[1].toUpperCase(), year: match[2], serial: Number(match[3]) }
}

/** 在已有编号中查重 */
export function isDuplicateCode(code: string, existing: string[]): boolean {
  return existing.some((item) => item.trim().toUpperCase() === code.trim().toUpperCase())
}

/** 依据已有序号生成下一个流水号 */
export function nextSerial(siteCode: string, year: number | string, existingCodes: string[]): number {
  const serials = existingCodes
    .map((code) => parseSpecimenCode(code))
    .filter((parsed): parsed is { siteCode: string; year: string; serial: number } => parsed !== null)
    .filter((parsed) => parsed.siteCode === siteCode.toUpperCase() && parsed.year === String(year))
    .map((parsed) => parsed.serial)
  return serials.length > 0 ? Math.max(...serials) + 1 : 1
}

/** 生成不与已有编号冲突的标本编号 */
export function allocateSpecimenCode(
  siteCode: string,
  year: number | string,
  existingCodes: string[],
  reserved: string[] = []
): string {
  const used = [...existingCodes, ...reserved]
  let serial = nextSerial(siteCode, year, used)
  let code = buildSpecimenCode(siteCode, year, serial)
  while (isDuplicateCode(code, used)) {
    serial += 1
    code = buildSpecimenCode(siteCode, year, serial)
  }
  return code
}

/** 采集地改代码时，卡住无法迁移的编号 */
export interface CodeRenameBlocked {
  /** 旧标本编号 */
  code: string
  /** 迁移后应得到的新编号；旧编号拆不出年份/流水号时为空 */
  newCode?: string
  /** 卡住原因 */
  reason: string
}

/** 采集地代码变更的迁移计划 */
export interface SiteCodeRenamePlan {
  /** 待更新标本：标本 id → 新编号（年份与流水号保持不变） */
  updates: { id: string; code: string }[]
  /** 卡住的旧编号：旧编号无法解析，或新编号与其他标本重复 */
  blocked: CodeRenameBlocked[]
}

/**
 * 规划采集地代码变更后、该采集地已有标本编号的迁移：
 * 仅替换编号的采集地代码前缀，保留原年份与流水号。
 * - 旧编号拆不出「代码-年份-流水号」→ 整条列入 blocked
 * - 新编号与其他采集地标本冲突，或本批次迁移后互相撞号 → 整条列入 blocked
 * 调用方应在 blocked 非空时放弃整笔保存（采集地与标本都不改动）。
 */
export function planSiteCodeRename(
  siteId: string,
  nextSiteCode: string,
  allSpecimens: Specimen[]
): SiteCodeRenamePlan {
  const prefix = nextSiteCode.trim().toUpperCase()
  const targets = allSpecimens.filter((item) => item.siteId === siteId)
  const targetIds = new Set(targets.map((item) => item.id))

  // 先逐条解析旧编号，拆不出年份/流水号的直接卡住
  const mapped = new Map<string, { oldCode: string; newCode: string }>()
  const blocked: CodeRenameBlocked[] = []
  for (const specimen of targets) {
    const parsed = parseSpecimenCode(specimen.code)
    if (!parsed) {
      blocked.push({ code: specimen.code, reason: '旧编号拆不出年份和流水号' })
      continue
    }
    const newCode = buildSpecimenCode(prefix, parsed.year, parsed.serial)
    mapped.set(specimen.id, { oldCode: specimen.code, newCode })
  }

  // 迁移集合之外的既有编号（大写归一后比较）
  const codesOutside = new Set(
    allSpecimens.filter((item) => !targetIds.has(item.id)).map((item) => item.code.trim().toUpperCase())
  )
  // 同一新编号被几条目标标本占用（迁移集合内部撞号）
  const ownersOfNewCode = new Map<string, string[]>()
  for (const [id, item] of mapped) {
    const key = item.newCode.toUpperCase()
    ownersOfNewCode.set(key, [...(ownersOfNewCode.get(key) ?? []), id])
  }

  const updates: { id: string; code: string }[] = []
  for (const [id, item] of mapped) {
    const key = item.newCode.toUpperCase()
    const clashOutside = codesOutside.has(key)
    const clashInside = (ownersOfNewCode.get(key) ?? []).length > 1
    if (clashOutside || clashInside) {
      blocked.push({
        code: item.oldCode,
        newCode: item.newCode,
        reason: clashOutside ? '新编号与其他标本编号重复' : '新编号与本采集地另一条标本迁移后重复'
      })
      continue
    }
    updates.push({ id, code: item.newCode })
  }

  blocked.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
  return { updates, blocked }
}

/** 经纬度格式化：116.4042°E, 39.9136°N */
export function formatLatLng(longitude: number, latitude: number): string {
  const lon = `${Math.abs(longitude).toFixed(4)}°${longitude >= 0 ? 'E' : 'W'}`
  const lat = `${Math.abs(latitude).toFixed(4)}°${latitude >= 0 ? 'N' : 'S'}`
  return `${lon}, ${lat}`
}

/** 经纬度格式校验 */
export function validateLatLng(longitude: number, latitude: number): string | null {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return '经纬度必须是数字'
  if (longitude < -180 || longitude > 180) return '经度必须在 -180 ~ 180 之间'
  if (latitude < -90 || latitude > 90) return '纬度必须在 -90 ~ 90 之间'
  return null
}

/** 柜位字符串编解码：C03-D2-B05-S12 */
export function encodeSlot(cabinet: string, drawer: number, box: number, slot: number): string {
  return `${cabinet.toUpperCase()}-D${drawer}-B${String(box).padStart(2, '0')}-S${String(slot).padStart(2, '0')}`
}

export function decodeSlot(text: string): { cabinet: string; drawer: number; box: number; slot: number } | null {
  const match = /^([A-Za-z0-9]+)-D(\d+)-B(\d+)-S(\d+)$/.exec(text.trim())
  if (!match) return null
  return { cabinet: match[1].toUpperCase(), drawer: Number(match[2]), box: Number(match[3]), slot: Number(match[4]) }
}

/** 标本在柜中的显示位置 */
export function storageSlotText(storage: Storage): string {
  return encodeSlot(storage.cabinet, storage.drawer, storage.box, storage.slot)
}

/** 检查柜位是否已被占用 */
export function findSlotConflicts(storages: Storage[], target: Storage): Storage[] {
  const key = storageSlotText(target)
  return storages.filter((item) => item.id !== target.id && storageSlotText(item) === key)
}

/** 标本摘要文本 */
export function specimenTaxon(specimen: Specimen): string {
  const parts = [specimen.order, specimen.family, specimen.genus, specimen.species].filter(Boolean)
  return parts.length > 0 ? parts.join(' / ') : specimen.tempName || '未定名'
}
