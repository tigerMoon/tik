export function parseLastJsonObject(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const trimmed = value.trim();
  const direct = parseObject(trimmed);
  if (direct) return direct;

  const fenced = Array.from(value.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi));
  for (const match of fenced.reverse()) {
    const parsed = parseObject(match[1].trim());
    if (parsed) return parsed;
  }

  for (let index = value.lastIndexOf('{'); index >= 0; index = value.lastIndexOf('{', index - 1)) {
    const parsed = parseObject(value.slice(index).trim());
    if (parsed) return parsed;
  }
  return null;
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
