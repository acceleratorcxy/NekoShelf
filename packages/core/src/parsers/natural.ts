/**
 * 自然序比较。
 * 规则：按「数字段 / 非数字段」切分逐段比较；数字段按数值比，其余按码点比。
 * 大小写不敏感但稳定：完全相同则保持原序（sort 稳定性由调用方保证）。
 */
export function naturalCompare(a: string, b: string): number {
  const ax = splitSegments(a);
  const bx = splitSegments(b);
  const len = Math.min(ax.length, bx.length);

  for (let i = 0; i < len; i += 1) {
    const x = ax[i]!;
    const y = bx[i]!;
    const xIsNum = /^\d+$/.test(x);
    const yIsNum = /^\d+$/.test(y);

    if (xIsNum && yIsNum) {
      const xn = Number(x);
      const yn = Number(y);
      if (xn !== yn) return xn - yn;
    } else if (xIsNum !== yIsNum) {
      // 数字段与非数字段：数字在前，保证 `img2` < `imgA`
      return xIsNum ? -1 : 1;
    } else {
      // 逐码点比较（不能用 localeCompare：ICU 会忽略标点，"_a.png" 与 "_a_cn.jpg" 会判反）
      const cmp = compareCodepoints(x.toLowerCase(), y.toLowerCase());
      if (cmp !== 0) return cmp;
    }
  }
  return ax.length - bx.length;
}

function compareCodepoints(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca !== cb) return ca - cb;
  }
  return a.length - b.length;
}

function splitSegments(value: string): string[] {
  return value.match(/\d+|\D+/g) ?? [];
}

export function sortNatural<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => naturalCompare(key(a), key(b)));
}
