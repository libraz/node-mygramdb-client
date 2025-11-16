/**
 * Robust native module loader with multiple fallback paths
 *
 * This loader is based on node-darts implementation and handles
 * various build configurations and CI environments.
 */
/* eslint-disable no-console */
/* eslint-disable import/no-dynamic-require */
/* eslint-disable global-require */
/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import * as path from 'path';
import * as fs from 'fs';

// Detect environment
const runtimePlatform = process.platform;
const runtimeArch = process.arch;
const isWindows = runtimePlatform === 'win32';
const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
const nodeABI = process.versions.modules;

/**
 * Get all possible paths for the native module
 */
function getNativePaths(): string[] {
  // When bundled, __dirname points to dist/
  // We need to go up to the package root
  const distPath = __dirname;
  const isInDist = distPath.endsWith('dist') || distPath.includes('/dist/');
  const basePath = isInDist ? path.join(__dirname, '..') : __dirname;

  const moduleName = 'mygram_native.node';

  const paths: string[] = [
    // Standard node-pre-gyp path with ABI versioning
    path.join(basePath, 'lib', 'binding', `node-v${nodeABI}-${runtimePlatform}-${runtimeArch}`, moduleName),

    // Standard build output
    path.join(basePath, 'build', 'Release', moduleName),
    path.join(basePath, 'build', 'Debug', moduleName),
    path.join(basePath, 'build', moduleName),

    // Windows-specific paths
    ...(isWindows
      ? [
          path.join(basePath, 'build', 'default', moduleName),
          path.join(basePath, 'out', 'Release', moduleName),
          path.join(basePath, 'out', 'Debug', moduleName),
          path.join(basePath, 'Release', moduleName),
          path.join(basePath, 'Debug', moduleName),
          path.join(basePath, 'addon-build', 'release', 'install-root', moduleName),
          path.join(basePath, 'addon-build', 'debug', 'install-root', moduleName),
          path.join(basePath, 'addon-build', 'default', 'install-root', moduleName)
        ]
      : []),

    // Relative to current file
    path.join(__dirname, '..', 'build', 'Release', moduleName),
    path.join(__dirname, '..', 'build', 'Debug', moduleName)
  ];

  return paths;
}

/**
 * Try to load native module from various paths
 */
export function loadNativeModule(): unknown {
  const paths = getNativePaths();

  if (isCI && isWindows) {
    console.log('[mygram-client] Running in Windows CI environment');
    console.log('[mygram-client] Node ABI:', nodeABI);
    console.log('[mygram-client] Platform:', runtimePlatform);
    console.log('[mygram-client] Arch:', runtimeArch);
    console.log('[mygram-client] Searching for native module in the following paths:');
    paths.forEach((p, i) => {
      const exists = fs.existsSync(p);
      console.log(`  [${i + 1}] ${exists ? '✓' : '✗'} ${p}`);
    });
  }

  // Try each path
  for (const modulePath of paths) {
    try {
      if (fs.existsSync(modulePath)) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
        const module = require(modulePath);

        if (isCI && isWindows) {
          console.log('[mygram-client] ✓ Successfully loaded native module from:', modulePath);
        }

        return module;
      }
    } catch (error) {
      // Continue to next path
      if (isCI && isWindows) {
        console.log('[mygram-client] ✗ Failed to load from:', modulePath);
        if (error instanceof Error) {
          console.log('[mygram-client]   Error:', error.message);
        }
      }
    }
  }

  // If we reach here, all paths failed
  if (isCI && isWindows) {
    console.log('[mygram-client] ✗ Native module not found in any of the expected locations');
  }

  return null;
}

/**
 * Try to load using bindings module (as fallback)
 */
export function loadWithBindings(): unknown {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const bindings = require('bindings');
    return bindings('mygram_native');
  } catch (error) {
    return null;
  }
}

/**
 * Main loader function with comprehensive fallback strategy
 */
export function tryLoadNative(): unknown {
  // Strategy 1: Try direct paths
  let nativeModule = loadNativeModule();
  if (nativeModule) {
    return nativeModule;
  }

  // Strategy 2: Try bindings module
  nativeModule = loadWithBindings();
  if (nativeModule) {
    return nativeModule;
  }

  // Strategy 3: Try node-pre-gyp
  try {
    const basePath = path.join(__dirname, '..');
    const packageJson = JSON.parse(fs.readFileSync(path.join(basePath, 'package.json'), 'utf8'));

    if (packageJson.binary) {
      const bindingPath = require('@mapbox/node-pre-gyp').find(path.join(basePath, 'package.json'));
      // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
      nativeModule = require(bindingPath);
      if (nativeModule) {
        return nativeModule;
      }
    }
  } catch (error) {
    // node-pre-gyp failed
  }

  return null;
}
