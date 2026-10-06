// Milestone 273: the developer/test account (debug keys, everything owned, no party limit...). It used to be named
// "test"; it is now "MrLooms" (see the rename in db.ts). Both names count, so nothing breaks while an old client or an
// un-migrated database is around. Compared case-insensitively.
export const isTestName = (name: string | null | undefined): boolean => {
  const n = String(name ?? "").toLowerCase();
  return n === "test" || n === "mrlooms";
};
