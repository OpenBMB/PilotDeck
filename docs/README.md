# Documentation

Start with the [contribution rules](../CONTRIBUTING.md). Module READMEs are short English entry points; this directory holds maintained operational guides and canonical contracts, not task delivery reports.

## Module entry points

- [Core runtime](../src/README.md), [Web application](../ui/README.md), [Desktop](../apps/desktop/README.md).
- [Shared runtime support](../packages/config/README.md), [repository tools](../scripts/README.md), [tests](../tests/README.md), [bundled skills](../skills/README.md).

## Setup and operations

- [Source installation](../README_SOURCE_INSTALL.md) and [Docker](../README_DOCKER.md).
- [Releases and signing](release.md), [Ubuntu DEB](ubuntu-desktop-support.md), [RPM](redhat-desktop-support.md), [Web updates](web-update.md).
- [Test selection](testing.md), [local transcription](funasr-installation.md), [cron scheduling](cron-scheduling.md), [Web search providers](web-search-providers.md).

## API and protocol reference

- [Chat/composer API](dialog-improvement-api.md), [onboarding API](onboarding-api.md) and its [OpenAPI schema](pilotdeck-onboarding-api.openapi.yaml).
- [Model pool API](model-pool-settings-api.md), [reasoning settings](reasoning-settings.md), [settings/background-task TRDs](trd/README.md).
- [Video generation](video-generation.md): optional configuration, durable job recovery, session-scoped media and exports.
- [Runtime boundaries](architecture/runtime-boundaries.md), [session timeline](architecture/session-timeline.md), [telemetry receiver contract](telemetry/receiver-contract.md).
- [Parallel workspace preparation](parallel-workspace-preparation.md): the model request overlaps the file-artifact baseline, while tools and matching hooks wait.

Update the relevant guide with the code. Keep one detailed source for each contract and link to it instead of duplicating it in module introductions. Store one-run evidence in PRs/CI artifacts or ignored local output directories.
