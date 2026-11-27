/**
 * Shared workspace types.
 *
 * The GUI and Host share these request and response types for workspace routes.
 *
 * Workspace conventions
 *   WorkspaceSpec describes the active source, folders, settings and unsupported fields.
 *   VS Code workspace files support the folders and settings subset.
 *   Each resolved root has its own ID. File operations specify the target folderId.
 *   Use the field names in the current workspace contract.
 */

/**
 * How the workspace was opened.
 *   directory opens a single directory.
 *   code-workspace opens a VS Code .code-workspace file.
 *   fallback selects ./workspace when the user has not chosen a workspace.
 */
export type WorkspaceSourceKind = 'directory' | 'code-workspace' | 'fallback';

/**
 * A root folder in a workspace.
 *
 * The Host generates its ID. Clients pass the folderId to file APIs.
 */
export interface WorkspaceFolderSpec {
  /** Host-assigned ID, e.g. wf-0, stable throughout a session. */
  id: string;
  /** Explicit workspace folder name or the directory basename. */
  name: string;
  /** Resolved absolute path in POSIX form. */
  absolutePath: string;
  /** Original path from the workspace file, or absolutePath for a directory source. */
  originalPath: string;
  /** Whether the original path was absolute. The UI uses this in its path warning. */
  isAbsolute: boolean;
}

/**
 * Unparsed workspace fields retained for compatibility notices.
 * Examples include extensions, tasks and launch.
 */
export interface UnsupportedField {
  /** Field name. */
  key: string;
  /** JSON type of the field, such as object or array. */
  kind: string;
}

/**
 * Full description of the active workspace.
 */
export interface WorkspaceSpec {
  /** Workspace ID increments on open. The fallback ID is always fallback. */
  id: string;
  /** Directory basename or workspace filename without the .code-workspace suffix. */
  name: string;
  /** Workspace source. */
  source: WorkspaceSourceKind;
  /** Absolute path of the source file for a code-workspace workspace. */
  sourcePath: string | null;
  /** Resolved folders. Every workspace has at least one. */
  folders: WorkspaceFolderSpec[];
  /** Unsupported fields retained for the UI. */
  unsupportedFields: UnsupportedField[];
  /** ISO timestamp when the workspace opened. */
  openedAt: string;
}

/**
 * Brief workspace status for health checks and startup logs.
 */
export interface WorkspaceSummary {
  /** Whether an active workspace exists. */
  available: boolean;
  id: string | null;
  name: string | null;
  source: WorkspaceSourceKind | null;
  /** Number of root folders. */
  folderCount: number;
}

/** Successful GET /api/workspaces/current response payload. */
export interface WorkspaceState {
  current: WorkspaceSpec | null;
  /** Whether the fallback is active after first launch or an unavailable workspace. */
  fallbackUsed: boolean;
  /** Reason the last open failed. Cleared on success. */
  lastError: string | null;
}

/** POST /api/workspaces/open request. */
export interface OpenWorkspaceRequest {
  /**
   * Absolute path selected by the user.
   *   A directory or
   *   a .code-workspace file.
   *
   * This Host management endpoint accepts absolute paths. Agent tools resolve paths within a run.
   */
  path: string;
}

/** Successful POST /api/workspaces/open response payload. */
export interface OpenWorkspaceResult {
  workspace: WorkspaceSpec;
}

/** POST /api/workspaces/save-file request. */
export interface SaveWorkspaceFileRequest {
  /** Destination folder. Omission selects the current active/default folder. */
  folderId?: string;
  /** Optional filename. Defaults to <workspace name>.code-workspace. */
  fileName?: string;
}

/** Successful POST /api/workspaces/save-file response payload. */
export interface SaveWorkspaceFileResult {
  /** Absolute path of the created or overwritten workspace file. */
  workspaceFilePath: string;
  /** Workspace reopened after saving. */
  workspace: WorkspaceSpec;
  /** Whether the save created a file. */
  created: boolean;
  /** Whether the save overwrote a file. */
  overwritten: boolean;
}

// ============================================================================
// Filesystem browsing for the Open Workspace dialog.
// ============================================================================

/**
 * One directory entry returned by the workspace browser.
 *
 * The Open Workspace dialog calls /api/fs/browse to browse directories.
 * The user selects a directory or a .code-workspace file,
 * then the dialog calls POST /api/workspaces/open.
 *
 * The response contains only the fields needed by the workspace picker.
 * File size and modification time are outside this contract.
 */
export interface BrowseEntry {
  /** Entry name. */
  name: string;
  /** Resolved absolute path in POSIX form. */
  absolutePath: string;
  /** Entry type. */
  type: 'directory' | 'file';
  /** Whether to highlight this entry as a .code-workspace file. */
  isCodeWorkspace: boolean;
  /** Whether the name starts with a dot. Hidden items are collapsed by default. */
  hidden: boolean;
}

/** GET /api/fs/browse query. */
export interface BrowsePathQuery {
  /**
   * Absolute directory to browse. An empty or omitted path selects the home directory.
   * The Host workspace picker accepts absolute paths.
   */
  path?: string;
}

/** Successful GET /api/fs/browse response payload. */
export interface BrowsePathResult {
  /** Resolved absolute path in POSIX form. */
  absolutePath: string;
  /** Absolute parent directory, or null at a drive or filesystem root. */
  parentPath: string | null;
  /** Entries sorted by directory first, then by name. */
  entries: BrowseEntry[];
}

/**
 * Starting locations such as the home directory, drive roots and the workspace parent.
 * GET /api/fs/initial-locations supplies these entries to the sidebar.
 */
export interface InitialLocation {
  /** Display label, e.g. Home or Current Workspace. */
  label: string;
  /** Absolute path in POSIX form. */
  absolutePath: string;
  /** Sidebar group: home, drive or workspace. */
  kind: 'home' | 'drive' | 'workspace';
}

/** Successful GET /api/fs/initial-locations response payload. */
export interface InitialLocations {
  /**
   * Platform identifier using Node process.platform values.
   * String literals keep the protocol independent of Node typings.
   * Common values are win32, linux and darwin. Other values pass through.
   */
  platform: 'win32' | 'linux' | 'darwin' | 'aix' | 'freebsd' | 'openbsd' | 'sunos' | 'cygwin' | 'netbsd' | string;
  /** Suggested starting locations in priority order. */
  locations: InitialLocation[];
}
