from pathlib import Path

path = Path("packages/host-runtime/src/code-intelligence.ts")
source = path.read_text()

old = '''  private tracker: WorkspaceRevisionTracker | undefined;
  private service: CodeIntelligenceService | undefined;
  private startPromise: Promise<void> | undefined;
'''
new = '''  private readonly tracker: WorkspaceRevisionTracker;
  private service: CodeIntelligenceService | undefined;
  private startPromise: Promise<void> | undefined;
'''
if old not in source:
    raise SystemExit("owned service tracker field anchor not found")
source = source.replace(old, new, 1)

old = '''  }) {
    this.input = input;
  }

  async query<Q extends LocalSemanticPlanningQuery>(
'''
new = '''  }) {
    this.input = input;
    // Construction is side-effect free: the tracker does not open its watcher or
    // baseline until ensureStarted(). Keeping the instance here lets planning arg
    // normalization consult the exact tracker coverage policy before the first query.
    this.tracker = new WorkspaceRevisionTracker({ root: input.root });
  }

  isRevisionTrackedPath(workspaceRelativePath: string): boolean {
    return this.tracker.isRevisionTrackedPath(workspaceRelativePath);
  }

  async query<Q extends LocalSemanticPlanningQuery>(
'''
if old not in source:
    raise SystemExit("owned service constructor anchor not found")
source = source.replace(old, new, 1)

old = '''    if (this.service !== undefined) await this.service.dispose();
    else this.tracker?.close();
    this.service = undefined;
    this.tracker = undefined;
'''
new = '''    if (this.service !== undefined) await this.service.dispose();
    else this.tracker.close();
    this.service = undefined;
'''
if old not in source:
    raise SystemExit("owned service dispose anchor not found")
source = source.replace(old, new, 1)

old = '''      this.startPromise = (async () => {
        const tracker = new WorkspaceRevisionTracker({ root: this.input.root });
        this.tracker = tracker;
        try {
          await tracker.start();
          this.service = new CodeIntelligenceService({
            workspaceId: this.input.workspaceId,
            repositoryId: this.input.repositoryId,
            tracker,
'''
new = '''      this.startPromise = (async () => {
        const tracker = this.tracker;
        try {
          await tracker.start();
          this.service = new CodeIntelligenceService({
            workspaceId: this.input.workspaceId,
            repositoryId: this.input.repositoryId,
            tracker,
'''
if old not in source:
    raise SystemExit("owned service startup anchor not found")
source = source.replace(old, new, 1)

path.write_text(source)
