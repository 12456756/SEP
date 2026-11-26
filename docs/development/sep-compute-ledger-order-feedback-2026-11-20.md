# 算力平台 N09 流水排序问题交接

日期：2026-11-20。本次仅修改 SEP，未修改算力平台代码。

2026-11-21 验收更新：算力方修复并重启测试服务后，SEP 已通过真实 HTTP 下的 13 条流水、`limit=3` 分页、混合免费/付费流水、翻页期间新增充值及固定快照检查。完整本地业务脚本最后退款及 `MATCHED` 对账通过，原排序阻塞已解除。详见 `sep-compute-local-acceptance-2026-11-21.md`。

## 已确认的问题

接口：`GET /api/v1/sep/enterprises/:enterprise_id/ledger`。

实际业务联调中，SEP 已完成网关对话、文生图、图像编辑、文生视频、图生视频、免费及付费结算、个人自费同步、钱包退回。企业流水达到 11 条后，N09 返回顺序为 `1,10,11,2,3,4,5,6,7,8,9`，SEP 拒绝确认对账。

定位：算力仓库 `backend/internal/service/sep_ledger.go` 的 `Ledger()`，当前约第 273 行：

```sql
SELECT id,sequence::text,type,...
FROM sep_ledger
WHERE enterprise_pk=$1 AND sequence>$2 AND sequence<=$3
ORDER BY sequence LIMIT $4
```

PostgreSQL 在 `ORDER BY sequence` 中选用了输出列 `sequence::text`，因此按字符串排序。已经在本地隔离算力数据库中用同一组 11 条真实测试流水验证：原查询返回 `1,10,11,2...9`；限定底层列后返回 `1,2...11`。

## 算力平台需要修正

排序必须明确引用原始整数列，例如：

```sql
SELECT id, sequence::text AS sequence_text, type, ...
FROM sep_ledger
WHERE enterprise_pk=$1 AND sequence>$2 AND sequence<=$3
ORDER BY sep_ledger.sequence ASC
LIMIT $4
```

响应 `sequence/after_sequence/snapshot_sequence` 继续使用十进制字符串；无需更改接口字段、签名或计费规则。

不能只在 SEP 对返回数组排序。错误排序发生在 `LIMIT` 之前，多页时可能已经遗漏流水；客户端无法证明数据完整。

## 验收要求

1. 至少生成 12 条流水，使用 `limit=3` 或 `limit=5` 分页；逐条数字递增，最终覆盖全部编号，无重复、无遗漏。
2. 混合结算的付费/免费两条流水均出现；免费流水不减余额。
3. 第一页之后继续充值或消费，后续页保持第一页的 `snapshot_sequence` 和同快照余额。
4. SEP 重跑 `backend/test/compute-platform.live.ts`，应通过最后的真实钱包退回和 `MATCHED` 对账断言。

SEP 已增加 `COMPUTE_LEDGER_ORDER_INVALID` 诊断及两位数回归测试。错误会保留上一条、本条及快照编号，不推进对账游标，不自动更改任何一侧余额。
