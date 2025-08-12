import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import { MCPSettings } from "./types";
import MyPlugin from "./main";
import { normalize, dirname } from "path";

export type ServerStatus = "running" | "stopped" | "error";

export class MCPServer {
  private process: ChildProcess | null = null;
  private status: ServerStatus = "stopped";
  private plugin: MyPlugin;

  constructor(plugin: MyPlugin) {
    this.plugin = plugin;
  }

  get Status(): ServerStatus {
    return this.status;
  }

  async start() {
    console.log("[MCP Server]: Attempting to start server...");
    try {
      const settings = this.plugin.settings;
      const adapter = this.plugin.app.vault.adapter;
      const pluginDir = this.plugin.manifest.dir || "obsidian-mcp-plugin";

      // A more reliable way to get the plugin path
      const manifestPath = await adapter.getResourcePath(
        `${pluginDir}/manifest.json`,
      );
      const rawPath = manifestPath.replace(
        /app:\/\/local|app:\/\/[a-zA-Z0-9-]+/,
        "",
      );
      const pluginPath = dirname(decodeURIComponent(rawPath));

      console.log(`[MCP Server]: Plugin path: ${pluginPath}`);

      const serverPath = normalize(`${pluginPath}/dist/mcp_server.js`);
      const nodePath = "node"; // Предполагаем что Node.js в PATH

      console.log(
        `[MCP Server]: Attempting to start server with node.js`,
      );
      console.log(`[MCP Server]: Server script path: ${serverPath}`);

      if (!fs.existsSync(serverPath)) {
        console.error(
          `[MCP Server ERROR]: Server script path does not exist: ${serverPath}`,
        );
        console.error(
          `[MCP Server INFO]: Run 'npm run build:mcp' to build the server`,
        );
        this.status = "error";
        return;
      }

      this.process = spawn(nodePath, [
        serverPath,
        "--transport",
        "stdio"
      ]);
      this.status = "running";

      this.process.stdout?.on("data", (data) => {
        console.log(`[MCP Server]: ${data}`);
      });

      this.process.stderr?.on("data", (data) => {
        this.status = "error";
        console.error(`[MCP Server ERROR]: ${data}`);
      });

      this.process.on("close", (code) => {
        this.status = "stopped";
        console.log(`[MCP Server]: Process exited with code ${code}`);
      });
    } catch (e) {
      console.error("[MCP Server CATCH]:", e);
      this.status = "error";
    }
  }

  stop() {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.status = "stopped";
      console.log("[MCP Server]: Stopped");
    }
  }

  restart() {
    this.stop();
    this.start();
  }
}
