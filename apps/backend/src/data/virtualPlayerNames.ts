/** 常见英文名池，用于虚拟玩家展示昵称（更像真人） */
export const VIRTUAL_PLAYER_NAMES = [
  'Aiden',
  'Alex',
  'Amanda',
  'Amy',
  'Andrew',
  'Angela',
  'Anthony',
  'Ashley',
  'Benjamin',
  'Brandon',
  'Brian',
  'Brittany',
  'Bryan',
  'Caleb',
  'Cameron',
  'Chloe',
  'Chris',
  'Christina',
  'Daniel',
  'David',
  'Dylan',
  'Edward',
  'Elena',
  'Emily',
  'Eric',
  'Ethan',
  'Evelyn',
  'Felix',
  'Grace',
  'Hannah',
  'Harry',
  'Heather',
  'Henry',
  'Isaac',
  'Ivan',
  'Jack',
  'Jacob',
  'James',
  'Jason',
  'Jennifer',
  'Jessica',
  'Jonathan',
  'Jordan',
  'Joseph',
  'Joshua',
  'Julia',
  'Justin',
  'Karen',
  'Katie',
  'Kevin',
  'Kyle',
  'Laura',
  'Leo',
  'Liam',
  'Lily',
  'Lucas',
  'Marcus',
  'Mark',
  'Martin',
  'Mason',
  'Matthew',
  'Megan',
  'Michael',
  'Michelle',
  'Nathan',
  'Nicole',
  'Noah',
  'Oliver',
  'Olivia',
  'Owen',
  'Patrick',
  'Paul',
  'Peter',
  'Rachel',
  'Rebecca',
  'Richard',
  'Ryan',
  'Samantha',
  'Samuel',
  'Sara',
  'Sean',
  'Sophia',
  'Steven',
  'Thomas',
  'Tiffany',
  'Timothy',
  'Tony',
  'Victoria',
  'Vincent',
  'William',
  'Zachary',
] as const;

export function shuffleInPlace<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** 从英文名池中挑一个房间内未占用的昵称；池耗尽则加数字后缀 */
export function pickVirtualNickname(used: Iterable<string>): string {
  const taken = new Set(
    [...used].map((name) => name.trim().toLowerCase()).filter(Boolean),
  );
  const pool = shuffleInPlace([...VIRTUAL_PLAYER_NAMES]);
  for (const name of pool) {
    if (!taken.has(name.toLowerCase())) return name;
  }
  for (let suffix = 2; suffix < 100; suffix += 1) {
    for (const base of pool) {
      const candidate = `${base}${suffix}`;
      if (candidate.length <= 32 && !taken.has(candidate.toLowerCase())) return candidate;
    }
  }
  return `Player${Date.now().toString().slice(-6)}`;
}
