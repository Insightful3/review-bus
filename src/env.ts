/**
 * The environment without git's own variables. A review-bus started from a git hook or a shell with
 * GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY or GIT_CONFIG_* set would otherwise
 * point every git call (ours, and the reviewers') at another repository, the author's included.
 */
export function envWithoutGit(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
}
