export interface ManifestRoute {
  path: string;
  method: string;
  label: string;
  component?: string;
  parentPath?: string;
}

export interface ManifestFile {
  path: string;
  content: string;
}

export interface Manifest {
  version: number;
  generatedAt: string;
  framework: string;
  routes: ManifestRoute[];
  files: ManifestFile[];
}

export interface PluginOptions {
  output?: string;
  framework?: 'react-router' | 'vue-router' | 'next-pages' | 'next-app' | 'nuxt' | 'sveltekit';
  include?: string[];
  exclude?: string[];
}

export type DetectedFramework = PluginOptions['framework'] | 'unknown';
