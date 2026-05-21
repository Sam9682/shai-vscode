# Requirements Document

## Introduction

The Docker Deployments Panel is a new webview-based panel for the shai-vscode extension that enables users to discover, deploy, stop, and monitor Docker Compose services directly from VS Code. It follows the existing WebviewViewProvider pattern used by ChatViewProvider and ReasoningViewProvider, and integrates into the Shai Chat activity bar container.

## Glossary

- **Deployments_Panel**: The webview-based UI panel registered as `shai-deployments-view` in the VS Code activity bar, responsible for rendering compose file lists, deployment controls, and log output.
- **Docker_Controller**: The backend component that manages Docker Compose process lifecycle including file discovery, deployment, stopping, status tracking, and log streaming.
- **Compose_File**: A Docker Compose configuration file matching one of the recognized patterns: `docker-compose.yml`, `docker-compose.yaml`, `compose.yml`, `compose.yaml`.
- **Deployment_Status**: The state of a compose file deployment, one of: `idle`, `deploying`, `running`, `stopping`, `error`.
- **Deploy_Result**: An object containing `success` (boolean), `exitCode` (number), and `output` (string) returned after a deployment attempt.
- **Stop_Result**: An object containing `success` (boolean) and `exitCode` (number) returned after a stop attempt.
- **Workspace_Root**: The root directory of the first open workspace folder in VS Code.

## Requirements

### Requirement 1: Compose File Discovery

**User Story:** As a developer, I want the panel to automatically find Docker Compose files in my workspace, so that I can see which deployments are available without manual configuration.

#### Acceptance Criteria

1. WHEN the Deployments_Panel receives a `ready` message, THE Docker_Controller SHALL scan the Workspace_Root for files matching the patterns `docker-compose.yml`, `docker-compose.yaml`, `compose.yml`, and `compose.yaml`.
2. THE Docker_Controller SHALL return a list of Compose_File entries where each entry contains the absolute file path, display file name, and relative path from the Workspace_Root.
3. WHEN no Compose_File exists in the Workspace_Root, THE Docker_Controller SHALL return an empty list.
4. THE Docker_Controller SHALL limit the Compose_File search to the Workspace_Root directory without recursing into subdirectories.
5. THE Docker_Controller SHALL return no duplicate entries in the discovery result.
6. WHEN no workspace folder is open in VS Code, THE Docker_Controller SHALL return an empty list.

### Requirement 2: Deploy Compose Services

**User Story:** As a developer, I want to deploy Docker Compose services from the panel, so that I can start my application containers without leaving VS Code.

#### Acceptance Criteria

1. WHEN a user clicks "Deploy" on a Compose_File, THE Deployments_Panel SHALL send a deploy message to the Docker_Controller with the selected file path.
2. WHEN a deploy request is received, THE Docker_Controller SHALL spawn a `docker compose -f <filePath> up -d --build` child process using the Workspace_Root as the working directory.
3. WHEN a deployment starts, THE Docker_Controller SHALL transition the Deployment_Status for that file from `idle` to `deploying`.
4. WHEN the docker compose process exits with code 0, THE Docker_Controller SHALL transition the Deployment_Status to `running` and return a Deploy_Result with `success: true`.
5. WHEN the docker compose process exits with a non-zero code, THE Docker_Controller SHALL transition the Deployment_Status to `error` and return a Deploy_Result with `success: false` and the exit code.
6. THE Docker_Controller SHALL capture all stdout and stderr output from the docker compose process in the Deploy_Result `output` field.

### Requirement 3: Real-Time Log Streaming

**User Story:** As a developer, I want to see deployment logs in real time, so that I can monitor build progress and diagnose issues without switching to a terminal.

#### Acceptance Criteria

1. WHILE a docker compose process is running, THE Docker_Controller SHALL forward each stdout and stderr chunk to the registered `onOutput` callback as the chunk is received.
2. WHEN the Docker_Controller forwards a log chunk, THE Deployments_Panel SHALL post a `log` message to the webview containing the chunk data.
3. THE Docker_Controller SHALL include all emitted chunks in the final Deploy_Result `output` field without omitting any data.

### Requirement 4: Stop Compose Services

**User Story:** As a developer, I want to stop running Docker Compose services from the panel, so that I can shut down containers when I no longer need them.

#### Acceptance Criteria

1. WHEN a user clicks "Stop" on a Compose_File, THE Deployments_Panel SHALL send a stop message to the Docker_Controller with the file path.
2. WHEN a stop request is received, THE Docker_Controller SHALL spawn a `docker compose -f <filePath> down` child process.
3. WHEN the docker compose down process exits with code 0, THE Docker_Controller SHALL transition the Deployment_Status to `idle` and return a Stop_Result with `success: true`.
4. WHEN the docker compose down process exits with a non-zero code, THE Docker_Controller SHALL transition the Deployment_Status to `error` and return a Stop_Result with `success: false`.
5. WHEN stop is called, THE Docker_Controller SHALL terminate any running child process previously spawned for that file path.

### Requirement 5: Deployment Status Tracking

**User Story:** As a developer, I want to see the current status of each deployment, so that I know which services are running, deploying, or in an error state.

#### Acceptance Criteria

1. THE Docker_Controller SHALL maintain a Deployment_Status for each Compose_File that has been interacted with.
2. WHEN `getStatus(filePath)` is called, THE Docker_Controller SHALL return the current Deployment_Status for that file path.
3. WHEN `getStatus(filePath)` is called for a file that has not been deployed, THE Docker_Controller SHALL return `idle`.

### Requirement 6: Concurrent Deploy Prevention

**User Story:** As a developer, I want the system to prevent duplicate deployments, so that I do not accidentally start multiple instances of the same compose stack.

#### Acceptance Criteria

1. WHEN `deploy(filePath)` is called while the Deployment_Status for that file is `deploying`, THE Docker_Controller SHALL reject the request without spawning a second process.
2. WHEN a concurrent deploy attempt is rejected, THE Deployments_Panel SHALL display a warning message indicating that a deployment is already in progress.

### Requirement 7: Error Handling — Docker Not Available

**User Story:** As a developer, I want clear feedback when Docker is not installed, so that I know what to do to fix the issue.

#### Acceptance Criteria

1. IF the `docker` command is not found on the system PATH when `deploy()` is called, THEN THE Docker_Controller SHALL return a Deploy_Result with `success: false` and a descriptive error message indicating Docker is not installed.
2. IF the `docker` command is not found on the system PATH when `stop()` is called, THEN THE Docker_Controller SHALL return a Stop_Result with `success: false`.
3. WHEN a Docker-not-found error occurs, THE Deployments_Panel SHALL display an error message instructing the user to install Docker and ensure it is on the system PATH.

### Requirement 8: Error Handling — No Compose Files Found

**User Story:** As a developer, I want a helpful message when no compose files exist, so that I understand why the panel is empty.

#### Acceptance Criteria

1. WHEN the Docker_Controller returns an empty list of Compose_File entries, THE Deployments_Panel SHALL display a placeholder message stating that no docker-compose.yml was found in the Workspace_Root.

### Requirement 9: Process Timeout Handling

**User Story:** As a developer, I want long-running deployments to be terminated after a timeout, so that stuck processes do not consume resources indefinitely.

#### Acceptance Criteria

1. WHEN a docker compose process runs longer than the configured timeout of 10 minutes, THE Docker_Controller SHALL terminate the process with a SIGTERM signal.
2. WHEN a process is terminated due to timeout, THE Docker_Controller SHALL transition the Deployment_Status to `error`.
3. WHEN a timeout termination occurs, THE Deployments_Panel SHALL notify the user that the deployment timed out.

### Requirement 10: Resource Cleanup on Dispose

**User Story:** As a developer, I want the extension to clean up Docker processes when it deactivates, so that orphaned processes do not remain running.

#### Acceptance Criteria

1. WHEN `dispose()` is called on the Docker_Controller, THE Docker_Controller SHALL terminate all tracked child processes.
2. WHEN `dispose()` is called, THE Docker_Controller SHALL clear all Deployment_Status entries.

### Requirement 11: Webview Panel Registration

**User Story:** As a developer, I want the Deployments Panel to appear in the Shai activity bar, so that I can access it alongside the existing Chat and Reasoning panels.

#### Acceptance Criteria

1. THE Deployments_Panel SHALL register as a WebviewViewProvider for the view ID `shai-deployments-view` within the Shai Chat activity bar container.
2. WHEN the webview is resolved, THE Deployments_Panel SHALL enable scripts and set local resource roots to the extension URI.
3. WHEN the webview is resolved, THE Deployments_Panel SHALL register a message listener for incoming webview messages.
4. THE Deployments_Panel SHALL provide a static `openPanel()` method for opening the panel in a standalone editor column.

### Requirement 12: Refresh Compose File List

**User Story:** As a developer, I want to refresh the compose file list, so that newly added or removed compose files are reflected in the panel.

#### Acceptance Criteria

1. WHEN the Deployments_Panel receives a `refresh` message from the webview, THE Docker_Controller SHALL re-scan the Workspace_Root for Compose_File entries.
2. WHEN the re-scan completes, THE Deployments_Panel SHALL post an updated `composeFiles` message to the webview.

### Requirement 13: Security — Path and Process Safety

**User Story:** As a developer, I want the extension to handle file paths and processes securely, so that malicious compose files cannot exploit the system.

#### Acceptance Criteria

1. THE Docker_Controller SHALL validate that all file paths passed to `docker compose -f` are within the Workspace_Root to prevent path traversal.
2. THE Docker_Controller SHALL spawn child processes with `shell: false` to prevent command injection.
3. THE Docker_Controller SHALL sanitize user-provided service names before passing them as process arguments.
