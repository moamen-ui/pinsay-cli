export type PickedActionDto = {
  text: string;
  prompt: string;
};

export type AiRuleApplyDto = {
  title: string;
  prompt: string;
  scope: string; // "Workspace" | "Project" | "Role" | "Personal"
  priority: number; // 1 = Workspace, 2 = Project, 3 = Role, 4 = Personal
  isPersonal: boolean;
  roleName?: string | null; // set on Role rules
};

export type ApplyPageDto = {
  url?: string | null;
  route?: string | null;
  title?: string | null;
  viewport?: string | null;
  device?: string | null;
  dpr?: number | null;
  uaRef?: string | null;
};

export type PageContextEntry = {
  level?: string;
  message: string;
  stack?: string;
  count?: number;
  occurredAt?: string;
  source?: string | null;
};

export type NetworkContextEntry = {
  method: string;
  url: string;
  statusCode: number | null;
  durationMs?: number;
  occurredAt?: string;
};

export type CapturedHeader = { name: string; value: string };
export type CapturedBody = {
  contentType?: string | null; sizeBytes?: number | null; text?: string | null;
  truncated?: boolean; omitted?: string | null;
};
export type NetworkCall = {
  method: string; url: string; statusCode: number | null; durationMs?: number; occurredAt?: string;
  startedAt?: string | null; kind?: string | null; error?: string | null; denied?: boolean; repeatCount?: number;
  requestHeaders?: CapturedHeader[]; responseHeaders?: CapturedHeader[];
  requestBody?: CapturedBody | null; responseBody?: CapturedBody | null;
};
export type UserStep = {
  kind: string; occurredAt?: string; selector?: string | null; label?: string | null;
  valueLength?: number | null; masked?: boolean; path?: string | null; title?: string | null;
};

export type PageContextDto = {
  id?: number;
  route?: string | null;
  environment?: number;
  lastEventAt?: string;
  consoleEntries?: PageContextEntry[];
  networkEntries?: NetworkContextEntry[];
  captureMomentAt?: string | null;
  windowSeconds?: number | null;
  bodyCaptureEnabled?: boolean;
  droppedEntryCount?: number;
  networkCalls?: NetworkCall[] | null;
  stepEntries?: UserStep[] | null;
};

export type QueueItemElement = {
  pageRef?: string | null;
  selector?: string | null;
  snapshot?: string | null;
  sourcePath?: string | null;
  screenshotUrl?: string | null;
  classes?: any;
  computedStyles?: any;
  appliedCssRules?: any;
  parent?: any;
  parentInfo?: any;
  route?: string | null;
  pageUrl?: string | null;
  pageTitle?: string | null;
  viewportWidth?: number | null;
  viewportHeight?: number | null;
  deviceType?: string | null;
};

export type QueueItemReply = {
  id?: number;
  authorId?: string;
  authorName?: string | null;
  body: string;
  createdAt?: string;
  isAi?: boolean;
};

export type QueueItem = {
  /** Internal id: used only for API calls; never shown. */
  id: number;
  /** The comment's number in its project (#12). */
  number: number;
  status: number | string;
  environment: number | string;
  body: string;
  authorName: string | null;
  createdAt: string;
  element: QueueItemElement;
  replies: QueueItemReply[];
  pickedActions: PickedActionDto[];
  aiRules: AiRuleApplyDto[];
  customFields?: { key: string; label: string; type: number | string; value: string; suggestedTool?: string | null }[];
  isBugReport: boolean;
  pageContextId?: number | null;
  page?: ApplyPageDto;
  pageContext?: PageContextDto;
  language?: string | null;
};

export type UntrustedString = {
  value: string;
  untrusted: true;
};

export type AiElementView = {
  appliedCssRules: any;
  classes: any;
  deviceType: string | null;
  pageTitle: string | null;
  pageUrl: string | null;
  parentInfo: any;
  route: string | null;
  selector: string | null;
  snapshot: string | null;
  sourcePath: string | null;
  viewportHeight: number | null;
  viewportWidth: number | null;
};

export type AiReplyView = {
  authorName: string | null;
  body: UntrustedString;
  isAi: boolean;
};

export type AiPickedActionView = {
  prompt: string;
  text: string;
};

/** One active AI rule on a comment, in the API's order (Workspace → Project → Role → Personal). */
export type AiRuleView = {
  title: string;
  prompt: string;
  scope: string;
  priority: number;
  isPersonal: boolean;
  /** Set on Role rules only. */
  roleName?: string;
};

export type AiCommentView = {
  appliedAt: string | null;
  appliedByLabel: string | null;
  authorName: string | null;
  body: UntrustedString;
  commitUrl: string | null;
  createdAt: string;
  element: AiElementView;
  environment: number | string;
  /** The comment's number in its project (#12) — the only reference people and agents type. */
  number: number;
  /** Internal database id, for support only. Never pass it to a command. */
  internalId: number;
  isBugReport: boolean;
  pickedActions: AiPickedActionView[];
  aiRules: AiRuleView[];
  replies: AiReplyView[];
  status: number | string;
};

export type ProjectStack = {
  frontend?: string[];
  backend?: string[] | null;
  aiTools?: string[];
  design?: any;
};

export type ApplyProjectContext = {
  productName: string;
  projectName: string;
  projectKey: string;
  commitStyle: 'Single' | 'Separate';
  /** `.pinsay/config.json → delegation`; absent (older config, or a test fixture) means `auto`. */
  delegation?: 'auto' | 'off';
  stack: ProjectStack;
  aiRules?: AiRuleApplyDto[];
};

export type ApplyPromptOptions = {
  plan?: boolean;
  /**
   * Resolves a stamped source hash to the file that produced it.
   *
   * Injected rather than imported so buildApplyPrompt stays a pure function of its inputs — it has
   * a golden-file test, and reading .pinsay/manifest.json from inside it would make that test
   * depend on whatever happened to be on disk.
   */
  resolveSource?: (hash: string | null | undefined) => {
    kind: 'manifest' | 'stale' | 'unknown';
    path?: string | null;
    component?: string | null;
    hash?: string;
    hint?: string;
  };
};

export type ApplyClientContext = {
  server: string;
  project: string;
  token?: string;
  apiKey?: string;
  cwd: string;
  /** The signed-in workspace's name (`/api/auth/me` `tenantName`), for the project-not-found message. */
  workspaceName?: string;
};

export type ApplyRunResult = {
  prompt: string;
  items: QueueItem[];
  context: ApplyProjectContext;
};
