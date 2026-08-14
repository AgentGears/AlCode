# Phase 0.9 compatibility constants

**Status:** frozen implementation constants for Phase 0.9

These constants implement the already-frozen Phase 0.9 contract. Changing one after external fixtures/packages depend on it is a compatibility change and follows project change control.

## ALCODE Agent Plugins hook extension namespace

ALCODE uses this client-extension namespace for its Phase 0.9 hook configuration:

```text
io.github.agentgears.alcode.hooks
```

The namespace is derived from the project-controlled GitHub organization identity (`AgentGears`) rather than asserting ownership of an unrelated DNS domain. Repository administration/write control under that organization is the control proof used for this v1 namespace decision.

Unknown client-extension namespaces remain ignored per the portable package contract. Only this exact namespace is interpreted as the ALCODE hook extension in Phase 0.9.

## Dynamic capability binding negotiation

The Agent Protocol capability string is:

```text
dynamic_capability_binding_v1
```

An Agent that does not advertise this capability must not receive dynamic plugin/MCP capabilities. Dynamic capability requests carry the opaque binding that was delivered for the inference that formed the call; missing bindings do not fall back to name-only dynamic execution.
