from pathlib import Path

p = Path("packages/host-runtime/src/host.ts")
s = p.read_text()
s = s.replace(
    "export interface AttachedAgent {\n  generationId: string;\n  programAgentGeneration: number;\n  detach(): void;\n}\n",
    "export interface AttachedAgent {\n  generationId: string;\n  detach(): void;\n}\n",
    1,
)
s = s.replace(
    "    return {\n      generationId: connection.generationId,\n      programAgentGeneration,\n      detach: () => {\n",
    "    return {\n      generationId: connection.generationId,\n      detach: () => {\n",
    1,
)
# The numeric generation is Host-owned; callers that construct ProgramDispatch
# read it from host.programAgents rather than widening the legacy AttachedAgent contract.
s = s.replace(
    "    const programAgentGeneration = await this.programAgents.attach(\n",
    "    await this.programAgents.attach(\n",
    1,
)
p.write_text(s)

p = Path("packages/host-runtime/src/program-agent-host.integration.test.ts")
s = p.read_text()
s = s.replace(
    '    const attached = await host.attachAgent(firstConnection.hostConnection, session, "Host prompt");\n',
    '    await host.attachAgent(firstConnection.hostConnection, session, "Host prompt");\n'
    '    const generation = host.programAgents.currentAgentGeneration(String(session.sessionId));\n'
    '    if (generation === null) throw new Error("missing current Program Agent generation");\n',
    1,
)
s = s.replace("      agentGeneration: attached.programAgentGeneration,\n", "      agentGeneration: generation,\n", 1)
s = s.replace("      agentGeneration: attached.programAgentGeneration,\n", "      agentGeneration: generation,\n", 1)
s = s.replace(
    '    const replacement = await host.attachAgent(secondConnection.hostConnection, resumed, "Host prompt", "agent_replaced");\n'
    '    expect(replacement.programAgentGeneration).toBeGreaterThan(attached.programAgentGeneration);\n',
    '    await host.attachAgent(secondConnection.hostConnection, resumed, "Host prompt", "agent_replaced");\n'
    '    const replacementGeneration = host.programAgents.currentAgentGeneration(String(session.sessionId));\n'
    '    if (replacementGeneration === null) throw new Error("missing replacement Program Agent generation");\n'
    '    expect(replacementGeneration).toBeGreaterThan(generation);\n',
    1,
)
p.write_text(s)
