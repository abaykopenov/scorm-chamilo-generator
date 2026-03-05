function clampTopK(value) {
  const parsed = Math.trunc(Number(value) || 6);
  return Math.max(1, Math.min(30, parsed));
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || left.length !== right.length) {
    return -1;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = Number(left[index]);
    const rightValue = Number(right[index]);
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
      return -1;
    }
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return -1;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function searchVectorRecords({ records, queryVector, topK }) {
  const normalizedTopK = clampTopK(topK);
  if (!Array.isArray(records) || records.length === 0) {
    return [];
  }

  const candidates = [];

  for (const record of records) {
    const chunks = Array.isArray(record?.chunks) ? record.chunks : [];
    const vectors = Array.isArray(record?.vectors) ? record.vectors : [];
    const count = Math.min(chunks.length, vectors.length);

    for (let index = 0; index < count; index += 1) {
      const score = cosineSimilarity(queryVector, vectors[index]);
      if (!Number.isFinite(score) || score < 0) {
        continue;
      }

      candidates.push({
        materialId: record.materialId,
        chunk: chunks[index],
        score
      });
    }
  }

  return candidates
    .sort((left, right) => right.score - left.score)
    .slice(0, normalizedTopK);
}
