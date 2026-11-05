# moc3-toolchain · MOC3 解析工具链

> 归属：`dsh-l2d-model-intelligence` Skill Phase 0/2（工具链注册与解析器候选）。
> 结果写入统一注册表 `data/bootstrap-state.sqlite` 的 `toolchain_components` 表。

## 组件与锁定锚点

| 组件 | 状态 | 锚点 | 说明 |
|---|---|---|---|
| python | present_verified | 3.13.14（系统） | smoke：`--version` 可执行 |
| py-moc3 | present_verified | **v0.1.0@2fb112e**（Ludentes/py-moc3，MIT，零依赖） | 读路径 verified；写往返 partial（见下） |
| LIVE2D-MOC3(rust) | missing | github.com/loliRururi/LIVE2D-MOC3（404） | Skill 候选项，上游不存在；本机亦无 cargo |

## py-moc3 获取与重建（vendor/ 不入库）

```bash
git clone https://github.com/Ludentes/py-moc3 vendor/thirdparty/py-moc3
git -C vendor/thirdparty/py-moc3 checkout 2fb112e   # 锁定当前验证过的提交
```

零依赖，直接以 `PYTHONPATH=vendor/thirdparty/py-moc3/src python -m moc3 ...` 运行，不 pip 安装、不落全局。

## 扫描

```bash
node tools/moc3-toolchain/scan.mjs            # 默认 smoke：大肥鱼.moc3 + Haru.moc3
node tools/moc3-toolchain/scan.mjs --moc3 <路径[,路径…]>
```

smoke 产物只写临时目录；模型源资产保持只读。

## 已知事实（2026-11-04 扫描）

- `大肥鱼.moc3`（MOC3 v5，16,498,560 字节）：`info` 可解析（147 parts / 822 deformers / 715 art meshes / 509 parameters / 3,670,832 keyforms）；`verify` 失败——重写后少 381KB。**结论：py-moc3 v0.1.0 对该模型只读可信，重写回写不支持**。本流水线只做只读检查，源资产不可变，不受影响；任何"修改 moc3"需求在此缺陷修复前必须拒绝。
- `Haru.moc3`（官方样例）：info + verify 双通过。
