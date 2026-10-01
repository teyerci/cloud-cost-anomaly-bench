export type SeededRandom = {
  next: () => number;
  int: (minInclusive: number, maxInclusive: number) => number;
  shuffle: <T>(items: T[]) => T[];
};

export function createSeededRandom(seed = 42): SeededRandom {
  let state = seed >>> 0;
  if (state === 0) state = 0x6d2b79f5;

  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    int: (minInclusive: number, maxInclusive: number) =>
      Math.floor(next() * (maxInclusive - minInclusive + 1)) + minInclusive,
    shuffle: <T>(items: T[]) => {
      const shuffled = [...items];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(next() * (index + 1));
        [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
      }
      return shuffled;
    }
  };
}
