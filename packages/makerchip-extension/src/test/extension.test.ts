import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { AddressInfo } from 'net';
import { installLiveDocSkill } from '../liveDocSkill';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});
});

/**
 * The Live Doc skill is composed at activation from bundled agent guidance plus the API reference
 * fetched from the connected sandhost (see liveDocSkill.ts). Both halves can fail quietly -- a
 * server that answers with the wrong thing, or a composition that drops a section -- so the
 * invariants are pinned here. A local server stands in for the sandhost, so no network is needed.
 */
suite('Live Doc skill composition', () => {
	const MARKER = '<!-- insert: agent-guidance — replaced by the extension. -->';
	const REFERENCE = `# Live Doc\n\nConcepts.\n\n${MARKER}\n\n## API Reference\n\nDetails.\n`;
	const extensionPath = path.resolve(__dirname, '..', '..');
	let skillsDir: string;
	let serve: (handler: http.RequestListener) => Promise<string>;
	const servers: http.Server[] = [];

	suiteSetup(() => {
		skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-doc-skill-'));
		serve = async (handler) => {
			const srv = http.createServer(handler);
			servers.push(srv);
			await new Promise<void>(res => srv.listen(0, res));
			return `http://localhost:${(srv.address() as AddressInfo).port}`;
		};
	});

	suiteTeardown(() => {
		for (const srv of servers) { srv.close(); }
		fs.rmSync(skillsDir, { recursive: true, force: true });
	});

	const reference: http.RequestListener = (req, res) => {
		if (req.url === '/doc_src/live_doc.md') {
			res.writeHead(200, { 'Content-Type': 'text/markdown' });
			res.end(REFERENCE);
		} else {
			res.writeHead(404);
			res.end('not found');
		}
	};

	const install = (serverUrl: string) =>
		installLiveDocSkill({ extensionPath, skillsDir, serverUrl, log: () => { } });
	// The skill without its frontmatter, whose description may name the tool too, for position checks.
	const body = (out: string) => out.slice(out.indexOf('\n---\n', 4) + 5);

	test('splices the bundled guidance into the fetched reference at the marker', async () => {
		const result = await install(await serve(reference));
		assert.strictEqual(result.action, 'composed', result.reason);
		const out = fs.readFileSync(result.skillPath, 'utf-8');
		assert.ok(out.startsWith('---\n'), 'frontmatter must lead the file');
		assert.ok(out.includes('makerchip_extract_pdf_figure'), 'agent guidance must be present');
		assert.ok(!out.includes('insert: agent-guidance'), 'the marker itself is consumed');
		const b = body(out);
		assert.ok(b.indexOf('Concepts.') < b.indexOf('makerchip_extract_pdf_figure')
			&& b.indexOf('makerchip_extract_pdf_figure') < b.indexOf('## API Reference'),
			'guidance lands between the concepts and the API details');
		assert.ok(out.includes('## API Reference') && out.includes('Details.'),
			'the rest of the reference survives the splice');
	});

	test('appends the guidance when the reference has no marker', async () => {
		// A sandhost serving a reference that predates the marker must still get the guidance.
		const base = await serve((_req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/markdown' });
			res.end('# Live Doc\n\n## API Reference\n\nDetails.\n');
		});
		const result = await install(base);
		assert.strictEqual(result.action, 'composed', result.reason);
		const out = fs.readFileSync(result.skillPath, 'utf-8');
		assert.ok(out.includes('makerchip_extract_pdf_figure'), 'guidance is never dropped');
		assert.ok(body(out).indexOf('## API Reference') < body(out).indexOf('makerchip_extract_pdf_figure'),
			'only its position degrades');
	});

	test('tolerates a trailing slash on the server URL', async () => {
		const base = await serve(reference);
		const result = await install(`${base}/`);
		assert.strictEqual(result.action, 'composed', result.reason);
	});

	test('degrades, keeping the guidance, when the server cannot be reached', async () => {
		const result = await install('http://127.0.0.1:1');
		assert.strictEqual(result.action, 'degraded');
		const out = fs.readFileSync(result.skillPath, 'utf-8');
		assert.ok(out.includes('makerchip_extract_pdf_figure'), 'guidance survives a failed fetch');
		assert.ok(out.includes('http://127.0.0.1:1/doc_src/live_doc.md'), 'names the URL that failed');
		assert.ok(/Do not guess at the API/.test(out), 'tells the agent what to do instead');
	});

	test('rejects a 200 that is not the reference', async () => {
		// A sandhost predating the route may answer with an HTML page rather than a 404.
		const base = await serve((_req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/html' });
			res.end('<html>404</html>');
		});
		const result = await install(base);
		assert.strictEqual(result.action, 'degraded');
		assert.match(result.reason!, /not the Live Doc reference/);
	});

	test('a later success repairs a degraded skill', async () => {
		await install('http://127.0.0.1:1');
		const result = await install(await serve(reference));
		const out = fs.readFileSync(result.skillPath, 'utf-8');
		assert.strictEqual(result.action, 'composed');
		assert.ok(!out.includes('UNAVAILABLE'), 'the degraded notice is gone');
		assert.ok(out.includes('## API Reference'), 'the reference replaced it');
	});
});
