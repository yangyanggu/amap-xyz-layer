// 将CommonJS模块转换为ES6
import commonjs from '@rollup/plugin-commonjs'
// 在node_模块中查找并绑定第三方依赖项
import nodeResolve from '@rollup/plugin-node-resolve'

import esbuild from 'rollup-plugin-esbuild'
import typescript from '@rollup/plugin-typescript';
import copy from "rollup-plugin-copy";


function isProd(){
  return process.env.NODE_ENV === 'production';
}

export default {
  external: [],
  input: 'src/index.ts',
  output: [
    {
      file: './dist/dist/index.mjs',
      format: 'es',
      sourcemap: true
    },
    {
      file: './dist/dist/index.cjs',
      format: 'cjs',
      sourcemap: true
    }
  ],
  // 监听的文件
  watch: {
    exclude: 'node_modules/**'
  },
  // 不参与打包
  plugins: [
    typescript({
      tsconfig: 'tsconfig.json'
    }),
    nodeResolve({
      extensions: ['.mjs', '.js', '.json', '.ts'],
    }),
    commonjs(),
    esbuild({
      // All options are optional
      include: /\.[jt]sx?$/, // default, inferred from `loaders` option
      exclude: /node_modules/, // default
      sourceMap: true, // default
      minify: isProd(),
      target: 'es2017', // default, or 'es20XX', 'esnext'
      jsx: 'transform', // default, or 'preserve'
      // Like @rollup/plugin-replace
      tsconfig: 'tsconfig.json', // default
      // Add extra loaders
      loaders: {
        // Add .json files support
        // require @rollup/plugin-commonjs
        '.json': 'json',
      },
    }),
    isProd() && copy({
      targets: [
        {
          src: './README.md', dest: './dist',
        },
        {
          src: './LICENSE', dest: './dist',
        },
        {
          src: './CHANGELOG.md', dest: './dist',
        },
        {
          src: './src', dest: './dist',
        },
        {
          src: './package.json', dest: './dist',transform(content){
            const json = JSON.parse(content.toString());
            delete json.devDependencies;
            delete json.scripts;
            return JSON.stringify(json, undefined, 2);
          }
        }
      ]
    }),
  ]
}
