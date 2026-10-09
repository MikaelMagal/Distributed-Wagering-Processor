/** UUIDv7: ordenável por tempo (bom para índices e paginação por cursor). */
export const newId = (): string => Bun.randomUUIDv7();
