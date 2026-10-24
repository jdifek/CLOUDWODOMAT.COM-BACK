// services/coverage.js — готовы ли данные за период (чистая функция, без обращения к БД)
//
// coverage.loadedFrom — история загружена начиная с этого момента
// coverage.loadedTo   — данные загружены до этого момента
// Период "готов", если история дошла до его начала, а курсор сбора догнал
// конец периода (или текущий момент, если период ещё идёт) с отставанием не больше maxLagMs.
export function isRangeComplete(coverage, startMs, endMs, nowMs = Date.now(), maxLagMs = 30 * 60 * 1000) {
  if (!coverage?.loadedFrom || !coverage?.loadedTo) return false;
  const loadedFrom = new Date(coverage.loadedFrom).getTime();
  const loadedTo = new Date(coverage.loadedTo).getTime();
  const target = Math.min(endMs, nowMs);
  return loadedFrom <= startMs && loadedTo >= target - maxLagMs;
}