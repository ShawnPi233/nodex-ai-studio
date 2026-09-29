export function selectedMessageRange(ids, startId, endId) {
  if (!startId && !endId) return []
  const start = startId ? ids.indexOf(startId) : 0
  const end = endId ? ids.indexOf(endId) : ids.length - 1
  if (start < 0 || end < 0) return []
  return ids.slice(Math.min(start, end), Math.max(start, end) + 1)
}
