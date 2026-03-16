/**
 * Robust native module loader with multiple fallback paths
 *
 * This loader is based on node-darts implementation and handles
 * various build configurations and CI environments.
 * ESM-compatible using import.meta.url and createRequire.
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const esmRequire = createRequire(import.meta.url);
const currentFilename = fileURLToPath(import.meta.url);
const currentDirname = path.dirname(currentFilename);

// Detect environment
const runtimePlatform = process.platform;
const runtimeArch = process.arch;
const isWindows = runtimePlatform === 'win32';
const nodeABI = process.versions.modules;

/**
 * Get all possible paths for the native module
 */
function getNativePaths(): string[] {
  // When bundled, currentDirname points to dist/
  // We need to go up to the package root
  const isInDist = currentDirname.endsWith('dist') || currentDirname.includes('/dist/');
  const basePath = isInDist ? path.join(currentDirname, '..') : currentDirname;

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
    path.join(currentDirname, '..', 'build', 'Release', moduleName),
    path.join(currentDirname, '..', 'build', 'Debug', moduleName)
  ];

  return paths;
}

/**
 * Try to load native module from various paths
 */
export function loadNativeModule(): unknown {
  const paths = getNativePaths();

  // Try each path
  for (const modulePath of paths) {
    try {
      if (fs.existsSync(modulePath)) {
        return esmRequire(modulePath);
      }
    } catch (_error) {
      // Continue to next path
    }
  }

  // If we reach here, all paths failed
  return null;
}

/**
 * Try to load using bindings module (as fallback)
 */
export function loadWithBindings(): unknown {
  try {
    const bindings = esmRequire('bindings');
    return bindings('mygram_native');
  } catch (_error) {
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
    const basePath = path.join(currentDirname, '..');
    const packageJson = JSON.parse(fs.readFileSync(path.join(basePath, 'package.json'), 'utf8'));

    if (packageJson.binary) {
      const bindingPath = esmRequire('@mapbox/node-pre-gyp').find(path.join(basePath, 'package.json'));
      nativeModule = esmRequire(bindingPath);
      if (nativeModule) {
        return nativeModule;
      }
    }
  } catch (_error) {
    // node-pre-gyp failed
  }

  return null;
}
