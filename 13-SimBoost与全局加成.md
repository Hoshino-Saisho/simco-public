# 13 · SimBoost 与全局加成体系

> 来源：`simboost.json`（🟢）、`registry/simboosts.json` / `simboosts-use-action.json`（🟢 verified）、
> `registry/finance-recreation.json`（🟢 verified）、`server/game/simboost-settings.ts`。

---

## 一、生产 / 销售速度加成（最重要的一条）

### 1.1 获得方式（🟢）

```
每 5 级得 3 个点：bonusPerLevel = 3
15 级时手上有 9 个点可以分配
点数在【生产】和【销售】之间分配，两边之和恒定，滑块只是搬运
每边下限 −3%，上限 = 初始点数 + 3%（从另一边搬过来的）
```

### 1.2 生效方式（🟢）

```
生产：effectiveTime = baseTime × (1 − (productionModifier + recreationBonus) / 100)
      等价于 ratePerHour ÷ (1 − bonus/100)         ← 见 03 章第 4 步
销售：effectiveUnitsSold = baseUnitsSold × (1 + (salesModifier + recreationBonus) / 100)
```

> ⚠️ **生产是"除以 (1−x)"，销售是"乘以 (1+x)"，两边不对称。**
> 生产 +50% → 时间 ×0.5（速度 2 倍）；销售 +50% → 速度 1.5 倍。

### 1.3 重新分配（realign）（🟢）

```
POST /api/v2/companies/me/bonus/     body { production: 整数 }
                                      负 = 往生产搬，正 = 往销售搬
花费： 从正值那边搬走 1 点 = 75 SB
       从负值那边搬走 1 点 = 100 SB
（2024 年从 150/200 减半到 75/100）
```

---

## 二、休闲加成 Recreation Bonus（🟢 verified）

```
recreationBonus = Σ  所有【休闲类】且【upkeep 生效中】的建筑的 size
```

休闲建筑只有 3 种：**城堡 `3` / 公园 `4` / 湖泊 `5`**（`buildings.json` category = recreation，
costUnits 40，建造 12 小时，salaryModifier 0，等级上限 3）。

**effect**：
```
生产：productionModifier + recreationBonus
销售：salesModifier + recreationBonus
高管薪资成本：costPerPercent = |salesModifier + recreationBonus| × 0.02
```

### upkeep 费用（🟢）
```
gO = [15, 25, 40]        // 第 1 / 2 / 3 座休闲建筑的 upkeep 订单，各花 15 / 25 / 40 SimBoost
```
upkeep 生效时会占用 `busy.upkeep`（category `'u'`），DTO 在 `upkeep_active` 且 `busy_until` 未过期时下发。

### ⚠️ 位置排除条件三处说法不一致
| 来源 | 说法 |
|---|---|
| `registry/finance-recreation.json`（🟢 verified，最可信） | position **不以 `l` 开头**（地标位） |
| `simboost.json` | position 不以 `Fp` 开头（搬迁队列） |
| `formulas_production.md §9` | 不在 `plaza-` 位 |

**以 registry 那条为准**（它带 bundle selector `zP` 的证据链且标了 verified）。

---

## 三、资源生产事件（Events）（🟢）

```
GET /api/v3/encyclopedia/events/{realmId}   →  { events: [{kind, speedModifier, since, until}] }
GET /api/v2/production-modifiers/{realmId}/

anHour = producedPerHourRaw × (speedModifier/100 + 1) × (345 / SALARY_MID[state]) ^ salaryModifier
```
- `speedModifier` 是整数百分比，正 = 加速，负 = 减速
- **同一资源同时只有一个事件**，新事件替换旧事件
- 持续时间由服务端定（典型几天到几周），常量 `PRODUCTION_SPEED_MODIFIER_DAYS = 21`
- 同时最多 `PRODUCTION_SPEED_MODIFIER_RESOURCES = 3` 个资源有事件
- 玩家**不能控制**事件，纯服务端调度
- UI 配色：正向绿色 DarkLemonLime，负向橙色 OrangePeel

---

## 四、加速 Acceleration（🟢 概念 / 🔵 数值）

```
effectiveSeconds = baseSeconds / acceleration.multiplier
```
来自 `user.levelInfo.acceleration.multiplier`，**按公司等级给**。
新手引导期常量 `ONBOARDING_ACCELERATION = 12`（即 12 倍速）。
🔵 各等级具体倍数由服务端下发（私服固定成 1）。

---

## 五、完整生产时间公式（官方给的四步版本）

```
1. anHour = producedPerHourRaw × (1 + speedModifier/100) × (345/SALARY_MID[state])^salaryModifier
2. hours  = quantity / anHour
3. hours  = hours × (1 − (productionModifier + recreationBonus) / 100)
4. seconds= hours × 3600 / acceleration
```
> 这一版和第 03 章的 `sNt` 版是同一件事的两种写法（一个作用在时间上、一个作用在速率上）。
> 严格算数值时用第 03 章那版（有官方截图验证）。

---

## 六、SimBoost 用途全表（42 种 action code）（🟢）

> 每条流水的 `action` 必须是**单字符**（a–z、0–9、A–F），前端表 `Bhe` 查不到就整页崩。
> `spendSimBoosts` 存的是负数，前端渲染 `-n.spendSimBoosts`。
> 读取：`GET /api/v2/players/simboosts-use/:companyId/`

| 码 | 用途 |
|:-:|---|
| `a` | 报纸广告位 |
| `b` | 解锁额外建筑地块 |
| `c` | **加速建造/升级**（也覆盖生产加速 rush） |
| `d` | 解锁展示柜槽位 |
| `e` | 解锁高管席位 |
| `f` | SimBoost 跨 realm 转移 |
| `g` | 解锁公司标签位（**200 SB**） |
| `h` | 加速高管招聘搜索 |
| `i` | 解锁建筑拍卖参与位 |
| `j` | 加速建筑放置/搬迁 |
| `k` | **休闲建筑 upkeep**（15 / 25 / 40） |
| `l` | 推广建筑拍卖 |
| `m` | 报纸 Reward 打赏（5 SB，需 20 级） |
| `n` | 兑换码 |
| `o` | **加速餐馆改装** |
| `p` | 每日奖励轨道 |
| `q` | 解锁 HQ 总部/皮肤 |
| `r` | 对高管使用 strike |
| `s` | 加速高管入职适应 |
| `t` | 加速高管培训 |
| `u` | **生产/销售加成滑块重分配**（75 / 100） |
| `v` | 改公司名 |
| `w` | Twitter 活动奖励 |
| `x` | **兑换成现金** |
| `y` | 研究同类拍卖 |
| `z` | 加速机器人安装 |
| `1` | NFT 广告（已下线） |
| `2` | 管理员调整 |
| `3` | 成就奖励 |
| `4` | 课程赠送 |
| `5` | 真钱购买 |
| `6` | 促销补偿 |
| `7` | 玩家赠礼 |
| `8` | 收藏品交易 |
| `9` | 老兵奖励 |
| `0` | 支付撤销扣回 |
| `A` | 礼品篮 |
| `B` | 回归玩家奖励 |
| `C` | 解锁私人助理 |
| `D` | 研究潜在候选人 |
| `E` | 研究挖角方 |
| `F` | 交易所手续费（用 SB 付） |

> `registry/simboosts-use-action.json` 明确写着：**bundle 里只有 GET，没有 POST**。
> 想 1:1 复刻时不要凭 action code 表就造一个通用的 POST 扣费接口。

---

## 七、SimBoost 换现金（🟢 / 🔵）

```
每日上限按 realm 阶段递增：2,000/天（阶段1）→ 4,000 → 6,000 → … 上限 10,000/天
每日重置
```
🔵 **官方汇率不可见。**

⚪ 私服实现的是**反方向**的一条：`exchangeMoneyForSimboosts` —— `简易 SB = floor(现金 / 250)`
（`EXCHANGE_CASH_PER_SIMBOOST = 250`，即 **250 现金换 1 SimBoost**），
另有 `EXCHANGE_DAILY_LIMIT = 10000`、`DAILY_PURCHASE_LIMIT = 20`。
私服**没有**实现官方那条 SimBoost → 现金。

## 八、SimBoost 来源（🟢）

真钱购买 · 成就 · 推荐奖励（被推荐人付费时）· 每日奖励轨道 · 卖收藏品 ·
兑换码 · 报纸奖励 · 老兵奖励 · 课程赠送 · Twitter 活动 · 其他玩家赠礼

购买费率常量 `PURCHASE_SIMBOOSTS_FEE = 0.1`。
