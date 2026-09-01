import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

function isDirectChild(path: string, baseDir: string): boolean {
	return resolve(dirname(path)) === resolve(baseDir) && basename(path) !== "" && !basename(path).includes(sep);
}

export function readBoundedRegularFile(
	path: string,
	baseDir: string,
	maxBytes: number,
	beforeOpenChild?: () => void,
	afterFileStat?: () => void,
): { text?: string; bytes?: number; error?: string } {
	if (!Number.isInteger(maxBytes) || maxBytes < 1) return { error: "Invalid read bound." };
	if (!isDirectChild(path, baseDir)) return { error: "Resource must be a direct child of its approved root." };

	let directoryDescriptor: number | undefined;
	let fileDescriptor: number | undefined;
	try {
		const baseStats = lstatSync(baseDir);
		if (!baseStats.isDirectory() || baseStats.isSymbolicLink()) return { error: "Approved resource root is not a regular directory." };
		directoryDescriptor = openSync(
			baseDir,
			constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
		);
		const openedBase = realpathSync(`/proc/self/fd/${directoryDescriptor}`);
		if (openedBase !== realpathSync(baseDir)) return { error: "Approved resource root changed during access." };

		beforeOpenChild?.();

		// Node does not expose openat(2). Opening a direct child through our held
		// directory descriptor fixes the parent inode for the entire validation/read
		// window; O_NOFOLLOW still rejects a symlink in the final component.
		const descriptorPath = `/proc/self/fd/${directoryDescriptor}/${basename(path)}`;
		fileDescriptor = openSync(
			descriptorPath,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
		);
		const stats = fstatSync(fileDescriptor);
		if (!stats.isFile()) return { error: "Resource is not a regular file." };
		if (stats.size > maxBytes) return { error: `Resource is larger than ${maxBytes} bytes.`, bytes: stats.size };
		afterFileStat?.();
		// Always reserve the full bound plus a sentinel byte and read to EOF. Sizing
		// from the first fstat could otherwise return partial instructions if the file
		// grows after validation.
		const output = Buffer.alloc(maxBytes + 1);
		let offset = 0;
		while (offset < output.length) {
			const read = readSync(fileDescriptor, output, offset, output.length - offset, null);
			if (read === 0) break;
			offset += read;
		}
		if (offset > maxBytes) return { error: `Resource is larger than ${maxBytes} bytes.`, bytes: offset };
		return { text: output.subarray(0, offset).toString("utf8"), bytes: offset };
	} catch {
		return { error: "Resource could not be opened safely." };
	} finally {
		if (fileDescriptor !== undefined) closeSync(fileDescriptor);
		if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
	}
}
