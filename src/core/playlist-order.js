function parseUploadDate(value) {
  const text = String(value || '').trim();
  if (/^\d{8}$/.test(text)) {
    const year = Number(text.slice(0, 4));
    const month = Number(text.slice(4, 6));
    const day = Number(text.slice(6, 8));
    const date = Date.UTC(year, month - 1, day);
    return Number.isFinite(date) ? date / 1000 : null;
  }
  const timestamp = Number(value);
  if (Number.isFinite(timestamp) && timestamp > 0) return timestamp > 1e12 ? timestamp / 1000 : timestamp;
  return null;
}

function sortOldestFirst(items) {
  return [...items].sort((left, right) => {
    const leftDate = parseUploadDate(left.uploadDate || left.timestamp);
    const rightDate = parseUploadDate(right.uploadDate || right.timestamp);

    if (leftDate !== null && rightDate !== null && leftDate !== rightDate) {
      return leftDate - rightDate;
    }
    if (leftDate !== null && rightDate === null) return -1;
    if (leftDate === null && rightDate !== null) return 1;

    const leftIndex = Number.isFinite(Number(left.originalIndex)) ? Number(left.originalIndex) : Number.MAX_SAFE_INTEGER;
    const rightIndex = Number.isFinite(Number(right.originalIndex)) ? Number(right.originalIndex) : Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

function addSequentialOrder(items) {
  return items.map((item, index) => ({ ...item, order: index + 1 }));
}

module.exports = {
  addSequentialOrder,
  parseUploadDate,
  sortOldestFirst,
};
