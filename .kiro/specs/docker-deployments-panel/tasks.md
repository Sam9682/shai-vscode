# Implementation Plan: Docker Deployments Panel

## Overview

Implement a webview-based Docker Deployments panel for the shai-vscode extension. The panel follows the existing WebviewViewProvider pattern (ChatViewProvider, ReasoningViewProvider) and integrates into the Shai Chat activity bar. A DockerController manages compose file discovery, deployment, stopping, status tracking, and log streaming via child processes.

## Tasks

- [x] 1. Define data models and interfaces
  - [x] 1.1 Create `src/docker/types.ts` with `ComposeFileInfo`, `DeploymentStatus`, `DeployOptions`, `DeployResult`, `StopResult`, and `IDockerController` interfaces
    - Define all types as specified in the design document
    - Export all types for use by DockerController and DeploymentsViewProvider
    - _Requirements: 1.2, 2.4, 2.5, 2.6, 4.3, 4.4, 5.1_

- [x] 2. Implement DockerController
  - [x] 2.1 Create `src/docker/dockerController.ts` with the `DockerController` class implementing `IDockerController`
    - Implement constructor accepting `vscode.ExtensionContext`
    - Implement `discoverComposeFiles()` scanning workspace root for `docker-compose.yml`, `docker-compose.yaml`, `compose.yml`, `compose.yaml` (non-recursive)
    - Return empty list when no workspace folder is open
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [ ]* 2.2 Write property test for compose file discovery
    - **Property 1: Discovery completeness**
    - **Property 2: Discovery does not recurse into subdirectories**
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5**

  - [x] 2.3 Implement `deploy(filePath, options?, onOutput?)` method
    - Validate file path is within workspace root (path traversal prevention)
    - Check current status is not `deploying` for the same file; reject if concurrent
    - Spawn `docker compose -f <filePath> up -d --build` with `shell: false`
    - Sanitize service names before passing as arguments
    - Stream stdout/stderr chunks to `onOutput` callback
    - Accumulate all output in `DeployResult.output`
    - Transition status: `idle` → `deploying` → `running` (exit 0) or `error` (non-zero)
    - Handle `ENOENT` spawn error for missing Docker CLI
    - Implement 10-minute timeout with SIGTERM
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.3, 6.1, 7.1, 9.1, 9.2, 13.1, 13.2, 13.3_

  - [ ]* 2.4 Write property tests for deploy
    - **Property 3: Status state machine correctness**
    - **Property 5: Concurrent deploy prevention**
    - **Property 7: Path traversal prevention**
    - **Property 8: Service name sanitization**
    - **Property 9: Command argument construction**
    - **Validates: Requirements 2.2, 2.3, 2.4, 2.5, 4.3, 4.4, 5.1, 5.2, 5.3, 6.1, 9.2, 13.1, 13.3**

  - [x] 2.5 Implement `stop(filePath)` method
    - Kill any running child process for the file path
    - Spawn `docker compose -f <filePath> down` with `shell: false`
    - Transition status to `idle` (exit 0) or `error` (non-zero)
    - Handle `ENOENT` spawn error for missing Docker CLI
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 7.2_

  - [x] 2.6 Implement `getStatus(filePath)` and `dispose()` methods
    - `getStatus` returns current `DeploymentStatus`, defaulting to `idle`
    - `dispose` terminates all tracked child processes and clears status map
    - _Requirements: 5.1, 5.2, 5.3, 10.1, 10.2_

  - [ ]* 2.7 Write property tests for dispose and status
    - **Property 4: Output completeness**
    - **Property 6: Dispose cleanup**
    - **Validates: Requirements 2.6, 3.1, 3.3, 10.1, 10.2**

- [x] 3. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement DeploymentsViewProvider
  - [x] 4.1 Create `src/views/deploymentsView.ts` with `DeploymentsViewProvider` class implementing `vscode.WebviewViewProvider`
    - Constructor accepts `extensionUri` and `DockerController`
    - Implement `resolveWebviewView()`: enable scripts, set local resource roots, register message listener
    - Handle webview messages: `ready`, `deploy`, `stop`, `refresh`
    - On `ready`: call `discoverComposeFiles()` and post `composeFiles` message
    - On `deploy`: call `deploy()`, forward log chunks via `postMessage({ type: 'log' })`, post `deployResult`
    - On `stop`: call `stop()`, post `stopResult`
    - On `refresh`: re-scan and post updated `composeFiles`
    - Display warning on concurrent deploy attempt
    - Display error message when Docker is not found
    - Display placeholder when no compose files found
    - Display timeout notification
    - _Requirements: 3.2, 6.2, 7.3, 8.1, 9.3, 11.1, 11.2, 11.3, 12.1, 12.2_

  - [x] 4.2 Implement webview HTML/CSS/JS for the deployments panel
    - Render compose file list with Deploy/Stop buttons per file
    - Show deployment status indicator per file
    - Show real-time log output area
    - Show placeholder message when no compose files exist
    - Show error/warning messages
    - _Requirements: 2.1, 4.1, 8.1_

  - [x] 4.3 Implement static `openPanel()` method for standalone editor column usage
    - Follow the same pattern as `ChatViewProvider.openPanel()` and `ReasoningViewProvider.openPanel()`
    - _Requirements: 11.4_

  - [ ]* 4.4 Write unit tests for DeploymentsViewProvider message handling
    - Test `ready` triggers discovery and posts compose files
    - Test `deploy` triggers deploy and streams logs
    - Test `stop` triggers stop and posts result
    - Test `refresh` triggers re-scan
    - _Requirements: 3.2, 11.3, 12.1, 12.2_

- [x] 5. Register panel and commands in extension
  - [x] 5.1 Update `package.json` to register `shai-deployments-view` in the `shai-chat` views container and add `shai-vscode.openDeployments` command
    - Add view entry with id `shai-deployments-view`, name `Deployments`, type `webview`
    - Add command entry for `shai-vscode.openDeployments` with title `Shai: Open Deployments`
    - Add activation event `onView:shai-deployments-view`
    - _Requirements: 11.1_

  - [x] 5.2 Update `src/extension.ts` to instantiate `DockerController` and `DeploymentsViewProvider`, register the webview view provider, and dispose the controller on deactivation
    - _Requirements: 10.1, 10.2, 11.1_

  - [x] 5.3 Update `src/commands/commands.ts` to register the `shai-vscode.openDeployments` command calling `DeploymentsViewProvider.openPanel()`
    - _Requirements: 11.4_

- [x] 6. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- The implementation uses TypeScript, consistent with the existing codebase
