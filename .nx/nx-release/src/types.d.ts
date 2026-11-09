export type Update = { name: string; version: string; type: string; from: string | null };
export type ParsedCommit = { pr: number; directory: string; updates: Update[] };
export type Declaration = { path: string; section: string; changed: boolean };
export type Lock = {
  importers: Record<string, Record<string, Record<string, { version: string }> | undefined>>;
  snapshots: Record<
    string,
    { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
  >;
};
export type Context = {
  directory: string;
  uv: boolean;
  declarations: Record<string, Declaration[]>;
  lock: Lock | null;
  distDeps: ReadonlySet<string>;
};
export type SkipReason = "dev" | "none";
export type Resolution = { groups: string[]; reason: SkipReason | null };
export type Dep = { name: string; from: string | null; version: string };
export type MainOptions = {
  argv?: string[];
  repoDir?: string;
  toolsRoot?: string;
  loadDistDeps?: (toolsRoot: string) => Promise<Set<string>> | Set<string>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
};
export type RootFilter = (section: string, name: string) => boolean;
export type Declarations = Record<string, Declaration[]>;
