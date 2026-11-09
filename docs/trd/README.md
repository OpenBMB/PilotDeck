# Technical contracts

Maintained backend boundaries and configuration behavior. Shared API details are linked rather than repeated; current source and tests remain authoritative when a contract changes.

| Area | Reference |
| --- | --- |
| Background processes | [Task lifecycle and output](41-background-task.md) |
| Model pool | [Ownership and consistency](52-model-pool-settings-api.md); [HTTP API](../model-pool-settings-api.md) |
| Routing | [Router settings](53-router-settings-api.md) |
| Search | [Search settings](54-search-settings-api.md); [provider adapters](../web-search-providers.md) |
| Anthropic cache | [Request markers and projection state](anthropic-prompt-cache.md) |
