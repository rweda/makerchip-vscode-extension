import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	// Load the required tl-verilog extension from this monorepo rather than installing it from the
	// Marketplace (where it may not be published yet, or may lag this tree).
	extensionDevelopmentPath: ['.', '../tlv-extension'],
	skipExtensionDependencies: true,
});
