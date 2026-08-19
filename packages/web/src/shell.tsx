import { useState, useSyncExternalStore, type FormEvent } from "react";
import type { PublicOperation, PublicProgram, RequestedDisposition } from "@alcode/application-protocol";
import { ApplicationClient } from "./client.ts";
import { PluginsPanel } from "./plugins-panel.tsx";

export interface SessionChoice { sessionId: string; label: string; }
export interface AlcodeAppProps { client: ApplicationClient; sessions: readonly SessionChoice[]; activeSessionId: string; onSelectSession(sessionId: string): void; }

function operationStatus(operation: PublicOperation): string {
  if (operation.effectStatus === "indeterminate") return operation.reconciliationStatus === "pending" ? "Effect unknown — reconciliation pending" : "Effect unknown";
  if (operation.lifecycleState !== "terminal") return operation.lifecycleState;
  return `${operation.executionOutcome ?? "complete"} · effect ${operation.effectStatus}`;
}

function verificationSummary(program: PublicProgram): string {
  const current = program.verification.filter((item) => item.status === "current").length;
  const stale = program.verification.filter((item) => item.status === "stale").length;
  const waived = program.verification.filter((item) => item.status === "waived").length;
  return `${current} current · ${stale} stale · ${waived} waived`;
}

export function AlcodeApp({ client, sessions, activeSessionId, onSelectSession }: AlcodeAppProps) {
  const state = useSyncExternalStore(client.subscribe, client.getState, client.getState);
  const [text, setText] = useState("");
  const [disposition, setDisposition] = useState<RequestedDisposition>("START_NOW");
  const [notice, setNotice] = useState<string | null>(null);
  const snapshot = state.snapshot;
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> { event.preventDefault(); const trimmed = text.trim(); if (!trimmed) return; const decision = await client.submit(trimmed, disposition); if (decision.decision === "accepted") { setText(""); setNotice(decision.admittedDisposition ? `Admitted as ${decision.admittedDisposition}` : "Accepted"); } else setNotice(`${decision.decision}${decision.reasonCode ? `: ${decision.reasonCode}` : ""}`); }
  const activeExecutionId = snapshot?.session.activeExecutionId;
  return <div data-ui="alcode.app" className="alcode-app">
    <aside data-ui="session.list" aria-label="Sessions"><h1>ALCODE</h1><div>{state.connection}</div><nav>{sessions.map((session) => <button key={session.sessionId} type="button" aria-current={session.sessionId === activeSessionId ? "page" : undefined} onClick={() => onSelectSession(session.sessionId)}>{session.label}</button>)}</nav>
      {snapshot ? <PluginsPanel client={client} plugins={snapshot.plugins ?? []} /> : null}
    </aside>
    <main data-ui="conversation.main">
      {state.error ? <div role="alert">{state.error}</div> : null}{state.connection === "resyncing" ? <div role="status">Resynchronizing Host state…</div> : null}
      <section data-ui="transcript" aria-label="Conversation">{snapshot?.transcript.map((message) => <article key={message.eventId} data-ui={`transcript.${message.role}`}><header>{message.role === "tool_result" ? "Tool result" : message.role}</header><pre>{message.text}</pre></article>)}</section>
      {(snapshot?.pendingProgramCreations?.length ?? 0) > 0 ? <section data-ui="program.pending" aria-label="Pending Program creation"><h2>Program approval</h2>{snapshot?.pendingProgramCreations?.map((pending) => <article key={pending.draftId} data-ui="program.creation.pending"><strong>{pending.objective}</strong><div>Pending exact Program draft</div><button type="button" onClick={() => void client.acceptProgramCreation(pending.draftId, pending.draftDigest)}>Accept Program</button></article>)}</section> : null}
      {(snapshot?.programs?.length ?? 0) > 0 ? <section data-ui="programs" aria-label="Programs"><h2>Program</h2>{snapshot?.programs?.map((program) => {
        const currentWork = program.currentWorkItemId === undefined ? undefined : program.workItems.find((work) => work.workItemId === program.currentWorkItemId);
        return <article key={program.programStateId} data-ui="program.card">
          <header><strong>{program.objective}</strong> · <span data-ui="program.lifecycle">{program.lifecycle}</span></header>
          <div data-ui="program.revision">Revision {program.revision}</div>
          <div data-ui="program.work">Current work: {currentWork ? `${currentWork.description} · ${currentWork.lifecycle}` : "none"}</div>
          <div data-ui="program.attempt">Attempt: {program.activeAttempt ? `${program.activeAttempt.programAttemptId} · agent ${program.activeAttempt.agentGeneration}` : "none"}</div>
          <div data-ui="program.verification">Verification: {verificationSummary(program)}</div>
          <div data-ui="program.blockers">Blockers: {program.blockers.length === 0 ? "none" : program.blockers.map((blocker) => blocker.reason).join("; ")}</div>
          <div data-ui="program.control">Control: {program.control.rebaseRequired ? "rebase required" : "base current"}{program.control.executionBaseUnavailable ? " · execution base unavailable" : ""}</div>
          <div data-ui="program.sessions">Attached sessions: {program.attachedSessionIds.length}</div>
          {program.lifecycle === "active" && program.control.rebaseRequired && program.control.mismatch ? <button type="button" onClick={() => void client.acceptProgramRebase(program.programStateId, program.revision, program.control.mismatch!.receiptId)}>Accept rebase</button> : null}{" "}
          {program.lifecycle === "active" ? <button type="button" onClick={() => void client.cancelProgram(program.programStateId, program.revision)}>Cancel Program</button> : null}
        </article>;
      })}</section> : null}
      <section data-ui="work.active" aria-label="Current work"><h2>Work</h2>{snapshot?.executions.map((execution) => <div key={execution.executionId} data-ui="execution.card"><strong>{execution.status}</strong> <code>{execution.executionId}</code></div>)}{snapshot?.operations.map((operation) => <article key={operation.operationId} data-ui="capability.card"><header>{operation.toolName}</header><div>{operationStatus(operation)}</div></article>)}</section>
      <section data-ui="queue" aria-label="Queued input"><h2>Queue</h2>{snapshot?.queue.map((item) => <div key={item.queueItemId} data-ui="queue.item"><span>{item.position}. {item.text}</span>{" "}<button type="button" disabled={Boolean(activeExecutionId)} onClick={() => void client.promote(item.queueItemId)}>Send now</button></div>)}</section>
      {snapshot?.pendingInteractions.map((interaction) => <section key={interaction.interactionId} data-ui="permission.interaction" aria-label="Permission request"><h2>Permission required</h2><strong>{interaction.toolName}</strong><p>{interaction.description}</p><button type="button" onClick={() => void client.respondPermission(interaction.interactionId,"allow_once")}>Allow once</button>{" "}<button type="button" onClick={() => void client.respondPermission(interaction.interactionId,"allow_always")}>Always allow</button>{" "}<button type="button" onClick={() => void client.respondPermission(interaction.interactionId,"deny")}>Deny</button></section>)}
      <form data-ui="composer" onSubmit={(event) => void submit(event)}><label>Admission<select value={disposition} onChange={(event) => setDisposition(event.target.value as RequestedDisposition)}><option value="START_NOW">Start now</option><option value="GUIDE">Guide current work</option><option value="QUEUE">Queue</option></select></label><textarea aria-label="Message" value={text} onChange={(event) => setText(event.target.value)} rows={4}/><button type="submit">Send</button>{" "}<button type="button" disabled={!activeExecutionId} onClick={() => activeExecutionId ? void client.cancel(activeExecutionId) : undefined}>Stop</button>{notice ? <div role="status">{notice}</div> : null}</form>
    </main>
  </div>;
}
