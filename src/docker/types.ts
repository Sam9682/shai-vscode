/**
 * Information about a discovered Docker Compose file in the workspace.
 */
export interface ComposeFileInfo {
  /** Absolute path to the compose file */
  filePath: string;
  /** Filename for display (e.g., "docker-compose.yml") */
  fileName: string;
  /** Relative path from workspace root */
  relativePath: string;
  /** Services defined in the compose file */
  services?: ComposeServiceInfo[];
}

/**
 * Information about a service defined in a Docker Compose file.
 */
export interface ComposeServiceInfo {
  /** Service name */
  name: string;
  /** Port mappings (e.g., ["8080:80", "443:443"]) */
  ports: string[];
}

/**
 * The state of a compose file deployment.
 */
export type DeploymentStatus = 'idle' | 'deploying' | 'running' | 'stopping' | 'error';

/**
 * Options for deploying a Docker Compose file.
 */
export interface DeployOptions {
  /** Run in detached mode (default: true) */
  detached?: boolean;
  /** Rebuild images before starting (default: true) */
  build?: boolean;
  /** Specific services to deploy (default: all) */
  services?: string[];
}

/**
 * Result returned after a deployment attempt.
 */
export interface DeployResult {
  success: boolean;
  exitCode: number;
  output: string;
}

/**
 * Result returned after a stop attempt.
 */
export interface StopResult {
  success: boolean;
  exitCode: number;
}

/**
 * Controller interface for managing Docker Compose process lifecycle.
 */
export interface IDockerController {
  discoverComposeFiles(): Promise<ComposeFileInfo[]>;
  deploy(filePath: string, options?: DeployOptions, onOutput?: (chunk: string) => void): Promise<DeployResult>;
  stop(filePath: string): Promise<StopResult>;
  getStatus(filePath: string): DeploymentStatus;
  dispose(): void;
}
