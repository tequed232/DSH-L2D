/**
 * model-import 测试夹具：常规模型 zip（makeZip 本体已提升为运行时库
 * packages/dsh-l2d-plugin/lib/zip-writer.mjs，此处只保留测试专用的模型 zip 形状）。
 */
import { makeZip } from '../../packages/dsh-l2d-plugin/lib/zip-writer.mjs';

/** 常规模型夹具：单根文件夹 + model3/moc3/贴图（嵌套布局，覆盖抬升逻辑）。 */
export function modelZip(modelName = 'demo-model') {
  return makeZip([
    { name: modelName + '/data/' + modelName + '.model3.json', data: JSON.stringify({ version: 3, FileReferences: { Moc: modelName + '.moc3' } }) },
    { name: modelName + '/data/' + modelName + '.moc3', data: Buffer.from('FAKEMOC3BYTES') },
    { name: modelName + '/data/texture00.png', data: Buffer.from('PNGDATA') },
    { name: modelName + '/README.txt', data: 'junk at zip root' },
  ]);
}
