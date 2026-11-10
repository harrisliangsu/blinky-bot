# 本地更新的数据比较合同

维护入口是同目录的 `local-update-install.py`，其 `prepare` 从同一目录加载
`local-update-data.py`，将 helper 文件哈希和 `messageFingerprintAlgorithm` 一起封存。
`run` 在取得安装锁、退出应用或替换 bundle **之前**核对算法合同。发布流程应使用
当前受审阅源码生成新 handoff，不再复制机器上某次旧更新目录里的 helper。

当前算法 `canonical-json-v1-ignore-top-level-streaming`：解析 JSON，递归规范对象键序，
只去除消息根层的临时 `streaming` 标记。数组顺序、类型、正文、展示正文、嵌套字段及附件引用仍参与比较。
SQLite 读取使用只读事务和 quick_check，检查点使用 backup API；不会直接改真实数据。

检查点写入算法标记。缺少或不匹配标记的旧检查点会明确拒绝混用，需要在另行授权的
安装流程中重新创建受审阅的检查点；不能重写旧哈希、修改旧安装状态或将历史失败改为成功。
机器上旧的私有安装 helper 仍由安装任务所有者处理，本源码修改不会触发旧任务或启动安装。

回归：`python3 Scripts/test-local-update.py`。它仅使用隔离合成 SQLite/文件，覆盖键序正例、
正文/类型/数组/附件等反例、旧合同拒绝，以及备份和读回边界。运行测试不是安装授权。
