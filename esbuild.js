const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const options = {
	entryPoints: ['src/extension.ts'],
	bundle: true,
	sourcemap: true,
	platform: 'node',
	format: 'cjs',
	outfile: 'dist/extension.js',
	external: ['vscode'],
};

if (watch) {
	esbuild.context(options)
		.then(c => c.watch())
		.catch(() => process.exit(1));
} else {
	esbuild.build(options)
		.catch(() => process.exit(1));
}
