import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DenseResult, SearchSkill } from "./search.js";

interface PendingRequest {
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	signal?: AbortSignal;
	onAbort?: () => void;
}

interface WorkerInstance {
	child: ChildProcessWithoutNullStreams;
	generation: number;
	exit: Promise<void>;
}

type WorkerState = "idle" | "running" | "failed" | "stopping";
const MAX_BUFFER_CHARS = 2 * 1024 * 1024;

export class EmbeddingClient {
	private worker: WorkerInstance | undefined;
	private state: WorkerState = "idle";
	private generation = 0;
	private buffer = "";
	private pending = new Map<string, PendingRequest>();
	private nextId = 1;
	private signature = "";
	private queue: Promise<unknown> = Promise.resolve();
	private stopPromise: Promise<void> | undefined;

	constructor(
		private readonly pythonPath = process.env.PI_PROGRESSIVE_SKILLS_PYTHON
			?? join(homedir(), ".cache", "pi-progressive-skills", "venv", "bin", "python"),
		private readonly modelPath = process.env.PI_PROGRESSIVE_SKILLS_MODEL_PATH
			?? join(homedir(), ".cache", "pi-progressive-skills", "models", "bge-small-en-v1.5"),
		private readonly workerPath = join(dirname(fileURLToPath(import.meta.url)), "embed_worker.py"),
	) {}

	available(): boolean {
		return this.state !== "failed" && existsSync(this.pythonPath) && existsSync(this.modelPath);
	}

	async search(
		skills: SearchSkill[],
		query: string,
		limit = 20,
		signal?: AbortSignal,
	): Promise<DenseResult[]> {
		return this.serial(async () => {
			signal?.throwIfAborted();
			if (!this.available()) return [];
			await this.ensureStarted();
			const signature = skills.map((skill) => `${skill.name}\0${skill.description}`).join("\u0001");
			if (signature !== this.signature) {
				const indexed = await this.request({
					op: "index",
					documents: skills.map((skill) => ({ name: skill.name, text: `${skill.name.replaceAll("-", " ")} ${skill.description}` })),
				}, 45_000, signal);
				if (indexed.ok !== true) {
					this.failForSession(new Error("embedding index unavailable"), this.worker);
					throw new Error("embedding index unavailable");
				}
				this.signature = signature;
			}
			const response = await this.request({ op: "search", query, limit }, 15_000, signal);
			if (response.ok !== true || !Array.isArray(response.results)) {
				this.failForSession(new Error("embedding search unavailable"), this.worker);
				return [];
			}
			return response.results.flatMap((value) => {
				if (!value || typeof value !== "object") return [];
				const { name, score } = value as { name?: unknown; score?: unknown };
				return typeof name === "string" && typeof score === "number" && Number.isFinite(score)
					? [{ name, score }]
					: [];
			});
		});
	}

	async stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		const instance = this.worker;
		if (!instance) {
			if (this.state !== "failed") this.state = "idle";
			return;
		}
		const operation = this.stopInstance(instance);
		this.stopPromise = operation.finally(() => {
			if (this.stopPromise) this.stopPromise = undefined;
		});
		return this.stopPromise;
	}

	private async stopInstance(instance: WorkerInstance): Promise<void> {
		if (this.worker === instance) {
			this.state = "stopping";
			this.buffer = "";
			this.signature = "";
			this.rejectAll(new Error("embedding worker stopped"));
		}
		instance.child.kill("SIGTERM");
		const exitedAfterTerm = await this.waitForExit(instance, 2_000);
		if (!exitedAfterTerm) {
			instance.child.kill("SIGKILL");
			await this.waitForExit(instance, 1_000);
		}
		if (this.worker === instance) {
			this.worker = undefined;
			this.buffer = "";
			this.signature = "";
			if (this.state !== "failed") this.state = "idle";
		}
	}

	private serial<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation, operation);
		this.queue = result.then(() => undefined, () => undefined);
		return result;
	}

	private async ensureStarted(): Promise<void> {
		if (this.stopPromise) await this.stopPromise;
		if (this.worker && this.state === "running") return;
		if (!this.available()) throw new Error("embedding worker unavailable");
		const child = spawn(this.pythonPath, ["-I", "-u", this.workerPath, "--model-path", this.modelPath], {
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				HF_HUB_OFFLINE: "1",
				TRANSFORMERS_OFFLINE: "1",
				TOKENIZERS_PARALLELISM: "false",
			},
		});
		const generation = ++this.generation;
		let resolveExit: (() => void) | undefined;
		const exit = new Promise<void>((resolve) => {
			resolveExit = resolve;
		});
		const instance: WorkerInstance = { child, generation, exit };
		this.worker = instance;
		this.state = "running";
		this.buffer = "";
		child.stderr.resume();
		child.stdin.on("error", () => {
			if (this.isCurrent(instance)) this.failForSession(new Error("embedding worker stdin failed"), instance);
		});
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (this.isCurrent(instance)) this.onData(instance, chunk);
		});
		child.once("exit", () => {
			resolveExit?.();
			if (!this.isCurrent(instance)) return;
			const expected = this.state === "stopping";
			this.worker = undefined;
			this.signature = "";
			this.buffer = "";
			this.state = expected ? "idle" : "failed";
			this.rejectAll(new Error("embedding worker exited"));
		});
		child.on("error", () => {
			if (this.isCurrent(instance)) this.failForSession(new Error("embedding worker failed"), instance);
		});
	}

	private request(
		payload: Record<string, unknown>,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const instance = this.worker;
		if (!instance || instance.child.killed || this.state !== "running") return Promise.reject(new Error("embedding worker unavailable"));
		signal?.throwIfAborted();
		const id = `req-${this.nextId++}`;
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				const pending = this.pending.get(id);
				if (!pending) return;
				clearTimeout(pending.timer);
				if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
				this.pending.delete(id);
			};
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error("embedding worker timeout"));
				if (this.isCurrent(instance)) this.failForSession(new Error("embedding worker timeout"), instance);
			}, timeoutMs);
			const onAbort = () => {
				cleanup();
				reject(signal?.reason instanceof Error ? signal.reason : new Error("embedding request aborted"));
				if (this.isCurrent(instance)) void this.stop();
			};
			this.pending.set(id, { resolve, reject, timer, signal, onAbort });
			if (signal) signal.addEventListener("abort", onAbort, { once: true });
			instance.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (error) => {
				if (!error) return;
				cleanup();
				reject(new Error("embedding worker write failed"));
				if (this.isCurrent(instance)) this.failForSession(new Error("embedding worker write failed"), instance);
			});
		});
	}

	private onData(instance: WorkerInstance, chunk: string): void {
		if (!this.isCurrent(instance)) return;
		this.buffer += chunk;
		if (this.buffer.length > MAX_BUFFER_CHARS) {
			this.failForSession(new Error("embedding worker protocol overflow"), instance);
			return;
		}
		while (true) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			let response: Record<string, unknown>;
			try {
				const parsed = JSON.parse(line);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
					this.failForSession(new Error("embedding worker protocol error"), instance);
					return;
				}
				response = parsed as Record<string, unknown>;
			} catch {
				this.failForSession(new Error("embedding worker protocol error"), instance);
				return;
			}
			const id = response.id;
			if (typeof id !== "string") {
				this.failForSession(new Error("embedding worker protocol error"), instance);
				return;
			}
			const pending = this.pending.get(id);
			if (!pending) continue;
			clearTimeout(pending.timer);
			if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
			this.pending.delete(id);
			pending.resolve(response);
		}
	}

	private failForSession(error: Error, instance: WorkerInstance | undefined): void {
		if (!instance || !this.isCurrent(instance) || this.state === "failed") return;
		this.state = "failed";
		this.buffer = "";
		this.signature = "";
		this.rejectAll(error);
		this.worker = undefined;
		instance.child.kill("SIGKILL");
	}

	private isCurrent(instance: WorkerInstance): boolean {
		return this.worker === instance && this.generation === instance.generation;
	}

	private async waitForExit(instance: WorkerInstance, timeoutMs: number): Promise<boolean> {
		let timer: NodeJS.Timeout | undefined;
		const timedOut = new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), timeoutMs);
		});
		const result = await Promise.race([instance.exit.then(() => true), timedOut]);
		if (timer) clearTimeout(timer);
		return result;
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
			pending.reject(error);
		}
		this.pending.clear();
	}
}
