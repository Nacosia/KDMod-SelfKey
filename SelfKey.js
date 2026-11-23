/**
 * SelfKey（自缚钥匙）—— KinkiestDungeon 纯 Mod
 * ============================================================================
 * 功能：自己穿戴 + 自己上锁的束缚具，解锁成功时不消耗钥匙/钥匙卡；
 *       但仍必须持有 ≥1 把对应钥匙（由原版 canUnlock 门禁保证，本 Mod 未处理）；
 *       敌人 / 陷阱 / 活体束缚 / 系统上的锁照常消耗。
 *
 * 目标游戏版本：KD 5.5.12（commit c9df467）。
 *
 * v1.1 显示层（只影响“看得见”，不影响任何判定）：
 *  - 名字角标：包装 KDGetItemName，自缚且当前锁有效时在名字前（默认，可在配置改为后置）
 *    加一个短角标（默认「※」，可切换 缚/锁/+/〔自缚〕 或关闭）。
 *  - 自锁提示：玩家自己上锁成功时发一条消息（可关）。
 *  - 悬停说明：注册 drawSGTooltip 事件，在束缚具悬停面板加一行“自缚锁：解锁不消耗钥匙”
 *    或“自缚标记已失效”（锁被外力换掉时）；官方事件，不改任何函数（可关）。
 *  - 状态栏计数：注册 drawBuffIcons 事件，显示当前“自缚锁 ×N”（可关）。
 *  以上四项全部只读标记、只画 UI；任一失效都不影响钥匙结算逻辑。
 *
 * 实现方式：
 *  1. KinkyDungeonRemoveKeysUnlock（KinkyDungeonRestraints.ts:1296-1298）
 *       唯一钥匙扣费收口。这里“暂存 pending，不立即扣”。
 *  2. KinkyDungeonLock（同文件 :710-763）
 *       上锁：按 unlockCtx / unlinkCtx / selfCtx 的优先级打标或清标；解锁：拿到 item，
 *       结合 pending 决定“免扣 / 照原版扣”，并保护 Crystal 嵌套换锁与解链重建的标记。
 *  3. KinkyDungeonUnlockAttempt（同文件 :2062-2097，门/箱）
 *       门/箱上下文标记，保证门照常扣（其内部 :2081 就调 RemoveKeysUnlock）。
 *  4. KDInputTypes["lock"]（KinkyDungeonInput.ts:10 / :127-138，玩家自锁输入）
 *       自锁上下文：其中的 KinkyDungeonLock(item, "White") 视为玩家自己上锁。
 *  5. KDDoEquipDelayed（KinkyDungeonRestraints.ts:7919-7952，背包穿戴）
 *  6. KDDoEquipGenericDelayed（同文件 :7956-8001，通用束缚 UI 穿戴）
 *       自缚穿戴上下文 + “穿戴前后 worn item id 差集”给新物品打 kdSelfWorn。
 *  7. KinkyDungeonUnLinkItem（同文件 :6379-6408，解链重建）
 *       解链时会把内层物品连同 UnLink.data / UnLink.lock 重新添加（:6394），并在 :5908
 *       重新上锁。用 unlinkCtx 标记这段重建过程，避免把复制过来的 kdSelfLock 误清 0。
 *  8. KDGetItemName（同文件 :7426-7454，显示名统一入口；v1.1 显示层）
 *       只在“自缚且当前锁有效”时给返回值追加角标，不参与任何逻辑比较。
 *  9. KDDrawModConfigs（Scripts/KDMods.ts:657-819，配置页绘制；纯显示）
 *       画之前把角标 list 的 options 和已存值换成当前语言的写法，英文界面不出中文。
 * 10. KDDrawMods（同文件 :140，Mods 列表绘制；纯显示）
 *       画之前把本 Mod 在列表里的名字换成当前语言（modname 不查文本表，只能运行时改）。
 * 通用事件（6 个）：afterModSettingsLoad / tick / afterLoadGame / afterNewGame
 *       + drawSGTooltip（v1.1 悬停说明）/ drawBuffIcons（v1.1 状态栏计数）。
 *       配置默认值、pending 兜底清理、运行时上下文复位、显示层只读绘制。
 *
 * 数据模型（只写 item.data，随存档保存，卸载后原版自动忽略）：
 *  - item.data.kdSelfWorn = 1  这件是玩家自己穿上的
 *  - item.data.kdSelfLock = 1  当前这把锁是玩家自己上的；0/缺省 = 外力锁
 *  - 免扣口径（默认严格 AND）：kdSelfWorn && kdSelfLock 同时为 1。
 *    配置里可放宽为“只看自锁”（KDSelfKeyRequireBoth=false），但会连
 *    “敌人给你穿 + 你自己锁”也免，需自行权衡。
 *
 * 安全约定：所有 hook 只做“决策 + 打标”，异常时尽量退回原版行为；
 */
(function () {
	"use strict";

	// ========================================================================
	// 0. 常量与默认配置
	// ========================================================================

	var MOD_ID = "SelfKey";
	var LOG_PREFIX = "[KDSelfKey] ";
	var VERSION = "1.1.2";
	var TARGET_GAME_VERSION = "5.5.12";

	// item.data 上的两个标记键（kd 前缀避免与现有/其它 mod 键冲突）
	var KEY_SELF_WORN = "kdSelfWorn"; // 1 = 自己穿上的
	var KEY_SELF_LOCK = "kdSelfLock"; // 1 = 当前锁是自己上的

	// 默认黑名单：强度敏感 / 一钥多用的锁，默认不免（配置 KDSelfKeyFreePrecious 可放开）
	var PRECIOUS_LOCKS = {
		Gold: true,
		GoldPlus: true,
		Masterwork: true
	};

	var DEFAULTS = {
		KDSelfKeyEnabled: true,
		KDSelfKeyRequireBoth: true,
		KDSelfKeyFreePrecious: false,
		KDSelfKeyNotify: true,
		KDSelfKeyDebug: false,
		// v1.1 显示层（全部只读 UI，不影响判定；任意关闭都不影响扣钥匙）
		KDSelfKeyShowNameMark: true,
		KDSelfKeyShowLockMsg: true,
		KDSelfKeyShowTooltip: true,
		KDSelfKeyShowCounter: true,
		KDSelfKeyNameMark: "※", // 名字角标的当前显示值（list 存显示值，逻辑换算成稳定 id）
		KDSelfKeyMarkPrefix: true // 角标放名字前面（默认）：列表里左边对齐、一眼扫到，且长名字不会被截掉
	};

	// 幂等：同一页面会话里被重复 eval 时不再安装第二遍
	try {
		if (typeof window !== "undefined" && window && window.KDSelfKey && window.KDSelfKey.__installed) {
			try { console.log(LOG_PREFIX + "已安装过，跳过重复加载。"); } catch (e) {}
			return;
		}
	} catch (e) { /* 非浏览器环境忽略 */ }

	// ========================================================================
	// 1. 原始函数快照（必须用裸全局名：顶层 function 声明可写、let 对象可改属性）
	// ========================================================================

	var orig = {
		removeKeys: null,     // KinkyDungeonRemoveKeysUnlock
		lock: null,           // KinkyDungeonLock
		unlockAttempt: null,  // KinkyDungeonUnlockAttempt
		equip: null,          // KDDoEquipDelayed
		equipGeneric: null,   // KDDoEquipGenericDelayed
		unlinkItem: null,     // KinkyDungeonUnLinkItem
		lockInput: null,      // KDInputTypes["lock"]
		itemName: null,       // KDGetItemName（v1.1 显示层）
		drawConfigs: null,    // KDDrawModConfigs（画配置页前刷新角标选项）
		drawMods: null        // KDDrawMods（画 Mods 列表前刷新本 Mod 的名字）
	};

	// 已安装的 hook 引用（供 doctor() 自检）
	var HOOK = {
		removeKeys: null,
		lock: null,
		unlockAttempt: null,
		equip: null,
		equipGeneric: null,
		unlinkItem: null,
		lockInput: null,
		itemName: null,
		drawConfigs: null,
		drawMods: null
	};

	var state = {
		selfCtx: 0,       // >0 = 正在执行“玩家自己”的穿戴 / 上锁
		doorCtx: 0,       // >0 = 正在执行门/箱解锁（钥匙必须照常扣）
		unlinkCtx: 0,     // >0 = 正在执行解链重建（KinkyDungeonUnLinkItem）
		pending: null,    // { lock: string, tick: number } 等待 KinkyDungeonLock 结算
		unlockCtx: null,  // { item } 解锁过程中，供 Crystal 嵌套换锁识别
		missing: [],      // 缺失的全局符号
		decisions: [],    // 最近决策（最多 20 条，doctor 用）
		lastDecision: null,
		stats: {
			freeUnlocks: 0,      // 判定为自缚、跳过扣费的解锁次数（含水晶多段）
			chargedUnlocks: 0,   // 判定为外力、按原版扣费的次数
			doorPassthrough: 0,  // 门/箱照常扣费次数
			selfWornMarks: 0,    // 打 kdSelfWorn 的次数
			selfLockMarks: 0,    // 打 kdSelfLock=1 的次数
			selfLockClears: 0,   // 外力上锁清 kdSelfLock 的次数
			unlinkKeeps: 0,      // 解链重建时保留 kdSelfLock 的次数
			pendingMismatch: 0,  // pending 与 item.lock 不一致、被迫按原版补扣的次数
			errors: 0            // hook 内部被捕获的异常数
		}
	};

	// ========================================================================
	// 2. 基础工具（全部自带 try/catch，Mod 侧异常绝不外溢）
	// ========================================================================

	function logError(where, err) {
		try {
			state.stats.errors++;
			// eslint-disable-next-line no-console
			console.error(LOG_PREFIX + where + ":", err);
		} catch (e) { /* ignore */ }
	}

	function logDebug(msg) {
		try {
			if (getSetting("KDSelfKeyDebug", DEFAULTS.KDSelfKeyDebug)) {
				// eslint-disable-next-line no-console
				console.log(LOG_PREFIX + msg);
			}
		} catch (e) { /* ignore */ }
	}

	/** 版本漂移导致符号缺失时的提示：只警告，不计入 errors（不代表脚本自身异常） */
	function logWarn(msg) {
		try {
			// eslint-disable-next-line no-console
			console.warn(LOG_PREFIX + msg);
		} catch (e) { /* ignore */ }
	}

	/**
	 * 读取配置。eval 发生在 KDLoadModSettings 之前，所以不能缓存；每次懒读。
	 * 配置值都在 KDModSettings[MOD_ID][refvar]；缺省时回落到 DEFAULTS。
	 */
	function getSetting(name, dflt) {
		try {
			if (typeof KDModSettings === "object" && KDModSettings) {
				var tab = KDModSettings[MOD_ID];
				if (tab && tab[name] !== undefined) return tab[name];
			}
		} catch (e) { /* ignore */ }
		return dflt;
	}

	function safeTick() {
		try {
			return typeof KinkyDungeonCurrentTick === "number" ? KinkyDungeonCurrentTick : -1;
		} catch (e) {
			return -1;
		}
	}

	/** 读 item.data[key]（用官方 KDItemDataQuery，拿不到就直读） */
	function dataGet(item, key) {
		try {
			if (!item) return undefined;
			if (typeof KDItemDataQuery === "function") return KDItemDataQuery(item, key);
			return item.data ? item.data[key] : undefined;
		} catch (e) {
			return undefined;
		}
	}

	/** 写 item.data[key]（用官方 KDItemDataSet，拿不到就直写；绝不整体覆盖 data） */
	function dataSet(item, key, value) {
		try {
			if (!item) return;
			if (typeof KDItemDataSet === "function") {
				KDItemDataSet(item, key, value);
				return;
			}
			if (!item.data || typeof item.data !== "object") item.data = {};
			item.data[key] = value;
		} catch (err) {
			logError("dataSet(" + key + ")", err);
		}
	}

	/** 当前所有穿戴中的束缚（含 dynamicLink 链） */
	function wornList() {
		try {
			if (typeof KinkyDungeonAllRestraintDynamic === "function") {
				return KinkyDungeonAllRestraintDynamic() || [];
			}
		} catch (err) {
			logError("wornList", err);
		}
		return [];
	}

	/**
	 * 穿戴前快照：item.id -> true（用于“前后差集”识别本次新穿上的物品）。
	 * 快照失败时返回 null（而不是空表），避免把身上所有旧物品误判为“本次新增”。
	 */
	function wornSnapshot() {
		var ids = {};
		try {
			var list = wornList();
			for (var i = 0; i < list.length; i++) {
				var it = list[i] && list[i].item;
				if (it && it.id !== undefined && it.id !== null) ids[it.id] = true;
			}
		} catch (err) {
			logError("wornSnapshot", err);
			return null;
		}
		return ids;
	}

	/** 本次装备的目标 Group（UI 传入的 data.group 即 restraint.Group；兼容个别调用方的 data.Group） */
	function resolveEquipGroup(data) {
		try {
			if (data && typeof data.group === "string" && data.group) return data.group;
			if (data && typeof data.Group === "string" && data.Group) return data.Group;
			if (data && data.name && typeof KinkyDungeonGetRestraintByName === "function") {
				var r = KinkyDungeonGetRestraintByName(data.name);
				if (r && r.Group) return r.Group;
			}
		} catch (err) {
			logError("resolveEquipGroup", err);
		}
		return null;
	}

	function restraintGroupOf(item) {
		try {
			if (typeof KDRestraint === "function") {
				var r = KDRestraint(item);
				if (r && r.Group) return r.Group;
			}
		} catch (err) { /* ignore */ }
		return null;
	}

	/** 免扣判定（严格 AND 默认；黑名单默认排除 Gold/GoldPlus/Masterwork） */
	function shouldExempt(item, lockName) {
		if (!item) return false;
		if (!getSetting("KDSelfKeyEnabled", DEFAULTS.KDSelfKeyEnabled)) return false;

		var selfWorn = dataGet(item, KEY_SELF_WORN) == 1;
		var selfLock = dataGet(item, KEY_SELF_LOCK) == 1;
		var requireBoth = getSetting("KDSelfKeyRequireBoth", DEFAULTS.KDSelfKeyRequireBoth) !== false;

		if (requireBoth) {
			// 已拍板口径：物品是自己穿的 + 当前锁是自己上的
			if (!(selfWorn && selfLock)) return false;
		} else {
			// 放宽口径：只看“谁上的锁”（会把“敌人给你穿 + 你自己锁”也免）
			if (!selfLock) return false;
		}

		if (!getSetting("KDSelfKeyFreePrecious", DEFAULTS.KDSelfKeyFreePrecious)) {
			if (lockName && PRECIOUS_LOCKS[lockName]) return false;
		}
		return true;
	}

	function recordDecision(free, lockName, item, p) {
		try {
			var d = {
				tick: safeTick(),
				lock: lockName || "",
				item: item && item.name ? item.name : "",
				itemId: item && item.id !== undefined ? item.id : null,
				selfWorn: dataGet(item, KEY_SELF_WORN) == 1,
				selfLock: dataGet(item, KEY_SELF_LOCK) == 1,
				pendingLock: p && p.lock ? p.lock : null,
				free: !!free,
				requireBoth: getSetting("KDSelfKeyRequireBoth", DEFAULTS.KDSelfKeyRequireBoth) !== false
			};
			state.lastDecision = d;
			state.decisions.push(d);
			if (state.decisions.length > 20) state.decisions.shift();
			logDebug("决策 " + JSON.stringify(d));
		} catch (err) {
			logError("recordDecision", err);
		}
	}

	function notifyFree(lockName) {
		try {
			if (!getSetting("KDSelfKeyNotify", DEFAULTS.KDSelfKeyNotify)) return;
			if (typeof KinkyDungeonSendTextMessage !== "function") return;

			var msg = textOr("KDSelfKeyFreeMsg",
				"[Self-lock] The ${LockName} lock is open — no key used.",
				{ LockName: lockTypeText(lockName) });

			var color = "#88FFAA";
			try {
				if (typeof KDBaseLightGreen !== "undefined" && KDBaseLightGreen) color = KDBaseLightGreen;
			} catch (e) { /* ignore */ }

			KinkyDungeonSendTextMessage(10, msg, color, 2);
		} catch (err) {
			logError("notifyFree", err);
		}
	}

	// ========================================================================
	// 2.5 显示层工具（v1.1：只读标记、只影响显示；异常绝不影响结算）
	// ========================================================================

	/**
	 * 文本 key（注册型）：内联英文是唯一事实源。先用 addTextKeyCareful 注册——
	 * eval 期翻译未落库、正常写入；CN.csv 后到覆盖成中文；运行期见已有译文不写
	 * （不会把英文盖回中文）；CSV 没加载时首次调用自愈英文。注册后查字典取当前
	 * 语言文案，查不到才退回内联英文（内联英文自己也要过一遍模板）。
	 */
	function textOr(key, en, params) {
		try {
			if (typeof addTextKeyCareful === "function") addTextKeyCareful(key, en);
		} catch (e) { /* ignore */ }
		try {
			if (typeof HasText === "function" && HasText(key)) return TextGet(key, params);
		} catch (e) { /* 下面用内联英文 */ }
		return applyParams(en, params);
	}

	/** 与引擎 applyTemplate 相同的替换规则（只认 ${字母数字下划线}）。 */
	function applyParams(text, params) {
		if (!params) return text;
		try {
			return String(text).replace(/\$\{(\w+)\}/g, function (m, k) {
				return params[k] !== undefined ? String(params[k]) : m;
			});
		} catch (e) {
			return text;
		}
	}

	/**
	 * 锁的显示名：物品名是 Kinky<锁>Lock，锁类型名是 Kinky<锁>LockType
	 * （例：KinkyWhiteLockType = "Simple"）。拿到就借用本体译文，拿不到退回内部锁 key。
	 */
	function lockTypeText(lockName) {
		if (!lockName) return "";
		try {
			if (typeof TextGet === "function") {
				var key = "Kinky" + lockName + "LockType";
				var lt = TextGet(key);
				if (lt && lt !== key && lt.indexOf("[NotFound]") < 0) return lt;
			}
		} catch (e) { /* 用锁 key */ }
		return lockName;
	}

	/**
	 * 显示状态（只读，不写任何东西）：
	 *   0 = 不显示；1 = 自缚锁有效（解锁免钥匙）；2 = 自缚穿戴但当前锁已非自锁（失效）。
	 * 判据与 shouldExempt 保持一致，保证“角标 / 提示所说不撒谎”；
	 * 另要求“当前确实有一把锁”——免费解锁后 item.lock 已清空，但 kdSelfLock 仍是 1，
	 * 若不加这一条，解锁完的物品会继续显示角标 / 计入状态栏（P1）。
	 */
	function displayState(item) {
		try {
			if (!item || !item.data) return 0; // 没有 data 就不可能带标记（dataSet 会先建 data）
			if (item.lock === undefined || item.lock === null || item.lock === "") return 0;
			var selfWorn = dataGet(item, KEY_SELF_WORN) == 1;
			var selfLock = dataGet(item, KEY_SELF_LOCK) == 1;
			if (!selfLock) return selfWorn ? 2 : 0;
			return shouldExempt(item, item.lock) ? 1 : 0;
		} catch (err) {
			return 0;
		}
	}

	// 名字角标：两个候选，稳定 id 与显示顺序一一对应。选项值既是显示文本、又是真正
	// 贴到名字上的字符，所以只存当前语言的写法，逻辑一律认 id。
	var MARK_IDS = ["star", "tag"];
	// 旧版存过的角标字符（v1.1 的 list 选项）：只用于认出存档，不显示。
	var MARK_LEGACY = { tag: ["缚", "锁", "+", "〔自缚〕", "〔SB〕"] };

	var markCache = { probe: null, labels: null };

	/**
	 * 当前语言的角标文字（顺序同 MARK_IDS）；文本表换了（CSV 加载完）会自动重取。
	 * 键和英文都写成字面量，离线自检脚本才能静态认出这两个文本键。
	 */
	function markLabels() {
		var labels = [
			textOr("KDSelfKeyMarkStar", "※"),
			textOr("KDSelfKeyMarkTag", "〔SB〕")
		];
		var probe = labels.join("\u0001");
		if (markCache.probe !== probe) markCache = { probe: probe, labels: labels };
		return markCache.labels;
	}

	/** 存档里的值 -> 稳定 id；认不出来返回 null。 */
	function markId(value) {
		if (typeof value !== "string" || value === "") return null;
		var labels = markLabels();
		var i = labels.indexOf(value);
		if (i >= 0) return MARK_IDS[i];
		for (i = 0; i < MARK_IDS.length; i++) {
			var aliases = MARK_LEGACY[MARK_IDS[i]];
			if (aliases && aliases.indexOf(value) >= 0) return MARK_IDS[i];
		}
		return null;
	}

	/** 稳定 id -> 当前语言的角标文字。 */
	function markLabel(id) {
		var index = MARK_IDS.indexOf(id);
		return markLabels()[index >= 0 ? index : 0];
	}

	/** 名字角标文字：认得出的存值按当前语言重取；认不出的原样用（不丢玩家的自定义字符）。 */
	function nameMarkText() {
		try {
			var v = getSetting("KDSelfKeyNameMark", DEFAULTS.KDSelfKeyNameMark);
			if (typeof v === "string" && v !== "") {
				var id = markId(v);
				return id ? markLabel(id) : v;
			}
		} catch (e) { /* 用默认 */ }
		return markLabel("star");
	}

	/**
	 * 画配置页前对齐角标选项：options 必须是当前语言的写法（英文界面不出现中文），
	 * 已存的值也要落到当前写法上，否则 list 的 indexOf 找不到它；从没存过时补默认。
	 */
	function refreshMarkOptions() {
		try {
			var labels = markLabels();
			var rows = (typeof KDModConfigs === "object" && KDModConfigs) ? KDModConfigs[MOD_ID] : null;
			if (rows) {
				for (var i = 0; i < rows.length; i++) {
					if (rows[i].type !== "list" || rows[i].refvar !== "KDSelfKeyNameMark") continue;
					rows[i].options = labels; // 语言一变 markLabels 就换新数组，这里每帧跟随
				}
			}
			if (typeof KDModSettings === "object" && KDModSettings) {
				var tab = KDModSettings[MOD_ID];
				if (tab) {
					var v = tab.KDSelfKeyNameMark;
					if (v === undefined) tab.KDSelfKeyNameMark = markLabel("star");
					else if (typeof v === "string") {
						var id = markId(v);
						if (id) tab.KDSelfKeyNameMark = markLabel(id);
					}
				}
			}
		} catch (err) {
			logError("refreshMarkOptions", err);
		}
	}

	/** 当前“自缚锁有效”件数（状态栏计数用） */
	function countSelfLocks() {
		var n = 0;
		try {
			var list = wornList();
			for (var i = 0; i < list.length; i++) {
				if (displayState(list[i] && list[i].item) === 1) n++;
			}
		} catch (err) {
			logError("countSelfLocks", err);
		}
		return n;
	}

	/** 玩家自己上锁成功时的提示（可关；同一件重复上锁会再提示一次） */
	function notifySelfLocked(item, lockName) {
		try {
			if (!getSetting("KDSelfKeyShowLockMsg", DEFAULTS.KDSelfKeyShowLockMsg)) return;
			if (typeof KinkyDungeonSendTextMessage !== "function") return;
			var name = "";
			try {
				if (item) {
					// 提示里用“原版名”，避免角标重复（【自缚锁】手铐〔自缚〕 会很啰嗦）
					if (typeof orig.itemName === "function") name = orig.itemName(item);
					else if (typeof KDGetItemName === "function") name = KDGetItemName(item);
					else name = item.name || "";
				}
			} catch (e) { name = (item && item.name) || ""; }
			var msg = textOr("KDSelfKeyLockMsg",
				"[Self-lock] ${ITEM} (${LOCK}) — unlocking it costs no key.",
				{ ITEM: name || "?", LOCK: lockTypeText(lockName) || "?" });
			var color = "#88FFAA";
			try { if (typeof KDBaseMint !== "undefined" && KDBaseMint) color = KDBaseMint; } catch (e) { /* ignore */ }
			KinkyDungeonSendTextMessage(8, msg, color, 2);
		} catch (err) {
			logError("notifySelfLocked", err);
		}
	}

	// ========================================================================
	// 3. pending 兜底（防止异常路径导致“钥匙被永久暂存”）
	// ========================================================================

	/**
	 * 把暂存的 pending 按原版语义立即结算（扣费）。
	 * 只应在“RemoveKeysUnlock 之后没有紧跟 KinkyDungeonLock”的异常/未知路径里调用。
	 */
	function flushPending(reason) {
		var p = state.pending;
		if (!p) return;
		state.pending = null;
		try {
			logDebug("flushPending(" + reason + ") lock=" + p.lock);
			orig.removeKeys(p.lock);
			state.stats.chargedUnlocks++;
		} catch (err) {
			logError("flushPending(" + reason + ")", err);
		}
	}

	// ========================================================================
	// 4. 自缚穿戴：kdSelfWorn（穿戴前后 worn item id 差集）
	// ========================================================================

	/**
	 * 给“本次装备新增的 worn item”打 kdSelfWorn=1，返回本次打标的物品（供显示层提示）。
	 * 用 Group 过滤，避免把装备过程中由物品事件连锁加上的其它部位也标成自缚；
	 * 如果拿不到 Group，则退化为“凡是本次新增的都标”（宁可能免则免，不影响 AND 的另一半）。
	 */
	function markNewSelfWorn(before, data) {
		var marked = [];
		try {
			if (!before) return marked; // 穿戴前快照失败：宁可不标（退化为原版扣钥匙），也不误标
			var target = resolveEquipGroup(data);
			var list = wornList();
			for (var i = 0; i < list.length; i++) {
				var it = list[i] && list[i].item;
				if (!it) continue;
				// P2-2：没有 id 的物品无法通过“前后差集”判定是否本次新增（before[undefined] 恒为假），
				// 直接跳过，避免把同 Group 的旧物品误标成自缚（正常引擎路径不可能出现，仅防坏档/第三方 Mod）。
				if (it.id === undefined || it.id === null) continue;
				if (before[it.id]) continue; // 旧物品

				var g = restraintGroupOf(it);
				if (target && g && g !== target) continue; // 连锁添加的别部位，不标

				dataSet(it, KEY_SELF_WORN, 1);
				state.stats.selfWornMarks++;
				marked.push(it);
				logDebug("标记自缚穿戴 " + it.name + " (id=" + it.id + ", group=" + g + ")");
			}
		} catch (err) {
			logError("markNewSelfWorn", err);
		}
		return marked;
	}

	/**
	 * 生成自缚使用包装：进入前快照、selfCtx++；退出后 selfCtx-- 并按差集打标。
	 * 注意：KDDoEquipDelayed / KDDoEquipGenericDelayed 只会给玩家（player.player）装备，
	 * 对 NPC 调用会在原函数里提前 return，差集自然为空。
	 */
	function makeEquipHook(origFn, hookName) {
		return function () {
			var data = arguments.length > 0 ? arguments[0] : null;
			var before = null;
			try { before = wornSnapshot(); } catch (e) { before = null; }

			state.selfCtx++;
			try {
				return origFn.apply(this, arguments);
			} catch (err) {
				// 原函数异常：记录后照常抛出（原版同样会抛，不吞掉以免掩盖引擎错误）
				logError(hookName, err);
				throw err;
			} finally {
				try { state.selfCtx--; } catch (e) { /* ignore */ }
				if (state.selfCtx < 0) state.selfCtx = 0;
				var marked = [];
				try { marked = markNewSelfWorn(before, data) || []; } catch (err) { logError(hookName + "/mark", err); }
				// v1.1 显示层：本次新穿上、且已经自锁的件，在两枚标记都落定后补一条上锁提示
				//（装备流程里锁先于 kdSelfWorn 写入，所以不能只在 KinkyDungeonLock 里提示）
				for (var mi = 0; mi < marked.length; mi++) {
					try {
						if (marked[mi] && marked[mi].lock && displayState(marked[mi]) === 1) {
							notifySelfLocked(marked[mi], marked[mi].lock);
						}
					} catch (e3) { /* ignore */ }
				}
			}
		};
	}

	// ========================================================================
	// 5. 钥匙扣费收口：KinkyDungeonRemoveKeysUnlock —— 只暂存
	// ========================================================================

	function makeRemoveKeysHook() {
		return function (lock) {
			// P2-5：区分“自身逻辑异常”与“原函数异常”。
			// 原函数一旦开始执行，其抛出的异常原样向上抛（与原版一致），绝不再二次调用以免重复扣费/重复副作用。
			var origCallStarted = false;
			try {
				// 总开关关闭：完全走原版
				if (!getSetting("KDSelfKeyEnabled", DEFAULTS.KDSelfKeyEnabled)) {
					origCallStarted = true;
					return orig.removeKeys.apply(this, arguments);
				}

				// 门 / 箱：必须照常立即扣（原版时序不变）
				if (state.doorCtx > 0) {
					flushPending("door"); // 理论上不存在，防御性处理
					state.stats.doorPassthrough++;
					origCallStarted = true;
					return orig.removeKeys.apply(this, arguments);
				}

				// 极端情况：上一条 pending 没被 KinkyDungeonLock 消费 → 先按原版结算，避免漏扣
				flushPending("stale");

				// 暂存，等紧邻的 KinkyDungeonLock(item, "") 里再决定
				state.pending = { lock: lock, tick: safeTick() };
				logDebug("暂存待结算 lock=" + lock + " tick=" + safeTick());
				return undefined;
			} catch (err) {
				logError("KinkyDungeonRemoveKeysUnlock", err);
				if (!origCallStarted) {
					// 自身逻辑在调用原函数之前就出错了：清掉可能残留的 pending，退回原版立即扣费
					try { state.pending = null; } catch (e) { /* ignore */ }
					return orig.removeKeys.apply(this, arguments);
				}
				// 异常来自原函数：不重复调用，原样抛出
				throw err;
			}
		};
	}

	// ========================================================================
	// 6. 解锁结算 + 上锁打标：KinkyDungeonLock
	// ========================================================================

	/**
	 * 解锁分支（lock == ""）。两条真实解锁路径都是“RemoveKeysUnlock 之后紧邻调用”：
	 *  - 即时成功：KinkyDungeonRestraints.ts:3369-3370
	 *  - 延迟完成：KDDelayedActions.ts:136-137
	 * 所以这里能拿到 item，用 pending + 物品标记决定“免扣 / 照原版扣”。
	 */
	function handleUnlock(self, args, item) {
		var p = state.pending;
		state.pending = null;

		// P2-1：pending 与目标 item 的“弱一致性”校验。
		// 正常两条解锁路径都是 RemoveKeysUnlock → KinkyDungeonLock 相邻两行，中间不可能插队；
		// 但若其它 Mod 在两者之间调用、或异常路径残留 pending，可能把 A 锁的结算吞成 B 的解锁
		//（方向是白嫖一次扣费）。发现不一致就按原版语义先补扣，再把本次当“无 pending”处理。
		if (p && item && p.lock && item.lock && p.lock !== item.lock) {
			try {
				state.stats.pendingMismatch++;
				logDebug("pending 与 item.lock 不一致：pending=" + p.lock + " item.lock=" + item.lock + "，按原版补扣");
				state.pending = p; // 交回 flushPending 统一结算
				flushPending("mismatch");
			} catch (err) {
				logError("handleUnlock/mismatch", err);
			}
			p = null;
		}

		var lockName = "";
		var free = false;
		try {
			lockName = (item && item.lock) || (p && p.lock) || "";
			free = !!(p && shouldExempt(item, lockName));
		} catch (err) {
			logError("handleUnlock/decide", err);
			free = false;
		}

		// 非自缚：保持原版时序（先结算钥匙，再执行 doUnlock；含 ExCrystal 的既有顺序缺陷）
		if (p && !free) {
			try {
				orig.removeKeys(p.lock);
				state.stats.chargedUnlocks++;
				recordDecision(false, lockName, item, p);
			} catch (err) {
				logError("handleUnlock/removeKeys", err);
			}
		}

		// unlockCtx 标记“正在解锁这件”，让 Crystal→ExCrystal 的嵌套换锁不要清掉 kdSelfLock
		var prevCtx = state.unlockCtx;
		state.unlockCtx = { item: item };
		try {
			var r = orig.lock.apply(self, args);

			if (free) {
				// 保险：嵌套换锁若走到了标记清理分支，这里再补回来
				try { dataSet(item, KEY_SELF_LOCK, 1); } catch (e) { /* ignore */ }
				state.stats.freeUnlocks++;
				recordDecision(true, lockName, item, p);
				// 只有“锁真的被清空”（完整解锁）才发提示；水晶第一段换锁不提示
				try {
					if (item && !item.lock) notifyFree(lockName);
				} catch (e) { /* ignore */ }
			}
			return r;
		} finally {
			state.unlockCtx = prevCtx;
		}
	}

	function makeLockHook() {
		return function (item, lock) {
			var origCalled = false;
			try {
				if (lock != "") {
					// —— 上锁 ——
					// 标记优先级（P1-1：解链重建要保标记；顺序不可调换）：
					//   ① 正在解锁同一件（unlockCtx.item === item）→ 保持（Crystal/ExCrystal 嵌套换锁）
					//   ② 正在解链重建（unlinkCtx>0）→ 保持（KinkyDungeonUnLinkItem 把 UnLink.data + UnLink.lock
					//      原样重加并重新上锁，复制过来的 kdSelfLock 不能被当成“外力上锁”清掉）
					//   ③ selfCtx>0（玩家自缚装备的 DefaultLock / “上锁”动作）→ 置 1（在原函数成功后）
					//   ④ 其它（敌人 / 活体 / 系统 / 监狱 / 事件上锁或换锁）→ 清 0
					var keepMark = false;
					try {
						var isUnlockSameItem = !!(state.unlockCtx && state.unlockCtx.item === item);
						keepMark = isUnlockSameItem || state.unlinkCtx > 0;
						if (!isUnlockSameItem && state.unlinkCtx > 0) {
							// 只为“本来就有自锁标记”的物品计数（外部物品重加时标记本就是 0，不计）
							if (dataGet(item, KEY_SELF_LOCK) == 1) {
								state.stats.unlinkKeeps++;
								logDebug("解链重建保留自锁标记 " + (item && item.name) + " lock=" + lock);
							}
						}
						if (!keepMark && !(state.selfCtx > 0)) {
							// P2-3：清标记提前到 orig.lock 之前——即使原函数在写入 item.lock 后抛异常，
							// 也不会留下“新锁已生效但 kdSelfLock 仍为 1”的残留（那会导致误免）。
							dataSet(item, KEY_SELF_LOCK, 0);
							state.stats.selfLockClears++;
						}
					} catch (err) {
						logError("KinkyDungeonLock/lock-pre", err);
					}

					origCalled = true;
					var r = orig.lock.apply(this, arguments);

					try {
						if (!keepMark && state.selfCtx > 0) {
							// 置 1 只在原函数成功后做（方向安全：该免未免好过误免）
							dataSet(item, KEY_SELF_LOCK, 1);
							state.stats.selfLockMarks++;
							logDebug("自锁标记 " + (item && item.name) + " lock=" + lock);
							// v1.1 显示层：只有“真的会免钥”的自锁才提示（严格 AND 下给敌人穿的物品自锁不提示，避免撒谎）
							try { if (displayState(item) === 1) notifySelfLocked(item, lock); } catch (e2) { /* ignore */ }
						}
					} catch (err) {
						logError("KinkyDungeonLock/lock-post", err);
					}
					return r;
				}

				// —— 解锁 ——
				origCalled = true;
				return handleUnlock(this, arguments, item);
			} catch (err) {
				logError("KinkyDungeonLock", err);
				if (!origCalled) {
					// 决策阶段就出错了：退回原版行为
					try { return orig.lock.apply(this, arguments); } catch (err2) { throw err2; }
				}
				// 原函数自己抛的异常：原样抛出，避免重复调用造成二次效果
				throw err;
			}
		};
	}

	// ========================================================================
	// 7. 门 / 箱隔离：KinkyDungeonUnlockAttempt
	// ========================================================================

	function makeUnlockAttemptHook() {
		return function () {
			var entered = false;
			try {
				state.doorCtx++;
				entered = true;
			} catch (err) {
				logError("KinkyDungeonUnlockAttempt/enter", err);
			}
			try {
				return orig.unlockAttempt.apply(this, arguments);
			} catch (err) {
				// 原函数异常：门/箱上下文已在 finally 复位，异常照常抛出
				logError("KinkyDungeonUnlockAttempt", err);
				throw err;
			} finally {
				if (entered) {
					try { state.doorCtx--; } catch (e) { /* ignore */ }
					if (state.doorCtx < 0) state.doorCtx = 0;
				}
			}
		};
	}

	// ========================================================================
	// 8. 玩家自锁输入：KDInputTypes["lock"]
	// ========================================================================

	function makeLockInputHook() {
		return function () {
			state.selfCtx++;
			try {
				return orig.lockInput.apply(this, arguments);
			} catch (err) {
				// 原函数异常：selfCtx 已在 finally 复位，异常照常抛出
				logError('KDInputTypes["lock"]', err);
				throw err;
			} finally {
				try { state.selfCtx--; } catch (e) { /* ignore */ }
				if (state.selfCtx < 0) state.selfCtx = 0;
			}
		};
	}

	// ========================================================================
	// 8.5 解链重建上下文：KinkyDungeonUnLinkItem（P1-1）
	// ========================================================================

	/**
	 * 解链重建：KinkyDungeonRestraints.ts:6379-6408。
	 * 取下外层束缚时，内层物品会带着 UnLink.data（含 kd 标记）和 UnLink.lock 被重新
	 * KinkyDungeonAddRestraint（:6394），并在 :5908 重新上锁。此时 selfCtx=0、unlockCtx=null，
	 * 若不额外标记就会被当成“外力上锁”把 kdSelfLock 清 0 → 之后解锁恢复扣费（P1-1）。
	 * 这里只标记“解链重建”这一段同步过程，粒度与其它上下文一致；不影响敌人真实上锁。
	 */
	function makeUnlinkItemHook() {
		return function () {
			state.unlinkCtx++;
			try {
				return orig.unlinkItem.apply(this, arguments);
			} catch (err) {
				// 原函数异常：unlinkCtx 已在 finally 复位，异常照常抛出
				logError("KinkyDungeonUnLinkItem", err);
				throw err;
			} finally {
				try { state.unlinkCtx--; } catch (e) { /* ignore */ }
				if (state.unlinkCtx < 0) state.unlinkCtx = 0;
			}
		};
	}

	// ========================================================================
	// 8.7 显示名角标：KDGetItemName（v1.1）
	// ========================================================================

	/**
	 * 只在返回值后追加显示后缀，不参与任何逻辑（引擎里的名字比较都用 item.name，
	 * 这条链路只用于显示）。异常只吞在“追加后缀”这一步；原函数抛错照常向上抛。
	 */
	function makeItemNameHook() {
		return function (item) {
			var base = orig.itemName.apply(this, arguments);
			try {
				if (getSetting("KDSelfKeyShowNameMark", DEFAULTS.KDSelfKeyShowNameMark)
					&& displayState(item) === 1) {
					var mark = nameMarkText();
					// 默认放前面：束缚具列表左边对齐，角标在同一列上最好扫；名字太长时也不会先被截掉
					base = getSetting("KDSelfKeyMarkPrefix", DEFAULTS.KDSelfKeyMarkPrefix)
						? (mark + " " + base)
						: (base + " " + mark);
				}
			} catch (err) {
				logError("KDGetItemName/suffix", err);
			}
			return base;
		};
	}

	// ========================================================================
	// 8.8 Mods 列表名：KDDrawMods
	// ========================================================================

	// mod.json 的 modname 由引擎原样画出来（不过文本表），所以按语言显示只能运行时改。
	// 白名单存放过的写法：只改自己的条目，不动别的 Mod。
	var MOD_NAME_KNOWN = ["SelfKey", "自缚钥匙", "自缚钥匙 SelfKey"];

	function localizeModListName() {
		try {
			if (typeof KDModInfo !== "object" || !KDModInfo) return;
			var localized = textOr("KDSelfKeyModName", "SelfKey");
			for (var zip in KDModInfo) {
				if (!Object.prototype.hasOwnProperty.call(KDModInfo, zip)) continue;
				var info = KDModInfo[zip];
				if (!info || typeof info !== "object") continue;
				if (MOD_NAME_KNOWN.indexOf(String(info.modname)) < 0) continue;
				info.modname = localized;
				return;
			}
		} catch (err) {
			logError("localizeModListName", err);
		}
	}

	/**
	 * 包一层列表绘制入口：画 Mods 列表之前改名字。CSV 解析完成时间不定，
	 * 但玩家点开 Mods 页时译文早已就绪，所以按绘制时机改比猜延迟可靠。
	 */
	function makeModListHook() {
		return function () {
			try { localizeModListName(); } catch (e) { /* 内部已记日志 */ }
			return orig.drawMods.apply(this, arguments);
		};
	}

	// ========================================================================
	// 9. 安装 hook
	// ========================================================================

	function installHooks() {
		// 9.1 KinkyDungeonRemoveKeysUnlock（函数声明，可整体替换）
		if (typeof KinkyDungeonRemoveKeysUnlock === "function") {
			orig.removeKeys = KinkyDungeonRemoveKeysUnlock;
			HOOK.removeKeys = makeRemoveKeysHook();
			KinkyDungeonRemoveKeysUnlock = HOOK.removeKeys;
		} else {
			state.missing.push("KinkyDungeonRemoveKeysUnlock");
		}

		// 9.2 KinkyDungeonLock
		if (typeof KinkyDungeonLock === "function") {
			orig.lock = KinkyDungeonLock;
			HOOK.lock = makeLockHook();
			KinkyDungeonLock = HOOK.lock;
		} else {
			state.missing.push("KinkyDungeonLock");
		}

		// 9.3 KinkyDungeonUnlockAttempt（门/箱）
		if (typeof KinkyDungeonUnlockAttempt === "function") {
			orig.unlockAttempt = KinkyDungeonUnlockAttempt;
			HOOK.unlockAttempt = makeUnlockAttemptHook();
			KinkyDungeonUnlockAttempt = HOOK.unlockAttempt;
		} else {
			state.missing.push("KinkyDungeonUnlockAttempt");
		}

		// 9.4 KDDoEquipDelayed / KDDoEquipGenericDelayed
		if (typeof KDDoEquipDelayed === "function") {
			orig.equip = KDDoEquipDelayed;
			HOOK.equip = makeEquipHook(orig.equip, "KDDoEquipDelayed");
			KDDoEquipDelayed = HOOK.equip;
		} else {
			state.missing.push("KDDoEquipDelayed");
		}
		if (typeof KDDoEquipGenericDelayed === "function") {
			orig.equipGeneric = KDDoEquipGenericDelayed;
			HOOK.equipGeneric = makeEquipHook(orig.equipGeneric, "KDDoEquipGenericDelayed");
			KDDoEquipGenericDelayed = HOOK.equipGeneric;
		} else {
			state.missing.push("KDDoEquipGenericDelayed");
		}

		// 9.5 KinkyDungeonUnLinkItem（解链重建，P1-1）
		if (typeof KinkyDungeonUnLinkItem === "function") {
			orig.unlinkItem = KinkyDungeonUnLinkItem;
			HOOK.unlinkItem = makeUnlinkItemHook();
			KinkyDungeonUnLinkItem = HOOK.unlinkItem;
		} else {
			state.missing.push("KinkyDungeonUnLinkItem");
		}

		// 9.6 KDInputTypes["lock"]（KDInputTypes 是顶层 let 对象，只能改属性）
		try {
			if (typeof KDInputTypes === "object" && KDInputTypes
				&& typeof KDInputTypes["lock"] === "function") {
				orig.lockInput = KDInputTypes["lock"];
				HOOK.lockInput = makeLockInputHook();
				KDInputTypes["lock"] = HOOK.lockInput;
			} else {
				state.missing.push('KDInputTypes["lock"]');
			}
		} catch (err) {
			logError("install/KDInputTypes", err);
			state.missing.push('KDInputTypes["lock"]');
		}

		// 9.7 KDGetItemName（v1.1 显示名角标；纯显示，失败不影响结算）
		if (typeof KDGetItemName === "function") {
			orig.itemName = KDGetItemName;
			HOOK.itemName = makeItemNameHook();
			KDGetItemName = HOOK.itemName;
		} else {
			state.missing.push("KDGetItemName");
		}

		// 9.8 KDDrawModConfigs（纯显示：画配置页前把角标选项换成当前语言的写法）
		try {
			if (typeof KDDrawModConfigs === "function") {
				orig.drawConfigs = KDDrawModConfigs;
				HOOK.drawConfigs = function () {
					try { refreshMarkOptions(); } catch (e) { /* 内部已记日志 */ }
					return orig.drawConfigs.apply(this, arguments);
				};
				KDDrawModConfigs = HOOK.drawConfigs;
			} else {
				state.missing.push("KDDrawModConfigs");
			}
		} catch (err) {
			logError("install/KDDrawModConfigs", err);
			state.missing.push("KDDrawModConfigs");
		}

		// 9.9 KDDrawMods（纯显示：画 Mods 列表前把本 Mod 的名字换成当前语言）
		if (typeof KDDrawMods === "function") {
			orig.drawMods = KDDrawMods;
			HOOK.drawMods = makeModListHook();
			KDDrawMods = HOOK.drawMods;
		} else {
			state.missing.push("KDDrawMods");
		}

		if (state.missing.length > 0) {
			logWarn("以下全局符号未找到，相关功能会退化为原版：" + state.missing.join(", "));
		} else {
			logDebug("全部 hook 安装完成。");
		}
	}

	// ========================================================================
	// 10. 配置页 / 文本注册 / 事件
	//    （引擎自取的 KDModButton 键在 registerTexts 里 eval 期注册）
	// ========================================================================

	function registerConfig() {
		try {
			if (typeof KDModConfigs !== "object" || !KDModConfigs) {
				logError("registerConfig", "找不到 KDModConfigs，配置页不会出现。");
				return;
			}

			KDModConfigs[MOD_ID] = [
				{ type: "boolean", refvar: "KDSelfKeyEnabled", default: DEFAULTS.KDSelfKeyEnabled },
				{ type: "boolean", refvar: "KDSelfKeyRequireBoth", default: DEFAULTS.KDSelfKeyRequireBoth },
				{ type: "boolean", refvar: "KDSelfKeyFreePrecious", default: DEFAULTS.KDSelfKeyFreePrecious },
				{ type: "boolean", refvar: "KDSelfKeyNotify", default: DEFAULTS.KDSelfKeyNotify },
				{ type: "boolean", refvar: "KDSelfKeyDebug", default: DEFAULTS.KDSelfKeyDebug },
				// v1.1 显示层
				{ type: "boolean", refvar: "KDSelfKeyShowNameMark", default: DEFAULTS.KDSelfKeyShowNameMark },
				{ type: "boolean", refvar: "KDSelfKeyMarkPrefix", default: DEFAULTS.KDSelfKeyMarkPrefix },
				{ type: "boolean", refvar: "KDSelfKeyShowLockMsg", default: DEFAULTS.KDSelfKeyShowLockMsg },
				{ type: "boolean", refvar: "KDSelfKeyShowTooltip", default: DEFAULTS.KDSelfKeyShowTooltip },
				{ type: "boolean", refvar: "KDSelfKeyShowCounter", default: DEFAULTS.KDSelfKeyShowCounter },
				{ type: "list", name: "KDSelfKeyNameMarkList", refvar: "KDSelfKeyNameMark", default: markLabel("star"), options: markLabels() }
			];
		} catch (err) {
			logError("registerConfig", err);
		}
	}

	/**
	 * 引擎自取文本键注册（eval 期执行）：KDModButton<tabKey> 选项卡标题 +
	 * KDModButton<refvar> 每个配置行标签。这些键没有 textOr 调用点，而引擎画配置页时
	 * 直接查字典，必须在 eval 期注册，否则显示 [NotFound]；英文即唯一事实源，
	 * CN.csv 加载后覆盖成中文。
	 */
	function registerTexts() {
		textOr("KDModButtonSelfKey", "SelfKey");
		textOr("KDModButtonKDSelfKeyEnabled", "Enable: self-locked restraints cost no keys");
		textOr("KDModButtonKDSelfKeyRequireBoth", "Strict AND (self-worn AND self-locked)");
		textOr("KDModButtonKDSelfKeyFreePrecious", "Also exempt Gold / GoldPlus / Masterwork");
		textOr("KDModButtonKDSelfKeyNotify", "Show a message when a key is saved");
		textOr("KDModButtonKDSelfKeyDebug", "Console debug logging");
		textOr("KDModButtonKDSelfKeyShowNameMark", "Show a mark next to self-locked restraint names");
		textOr("KDModButtonKDSelfKeyMarkPrefix", "Mark before the name (off = after)");
		textOr("KDModButtonKDSelfKeyShowLockMsg", "Show a message when you self-lock");
		textOr("KDModButtonKDSelfKeyShowTooltip", "Show a self-lock line in the tooltip");
		textOr("KDModButtonKDSelfKeyShowCounter", "Show the self-lock count in the HUD");
		textOr("KDModButtonKDSelfKeyNameMark", "Name mark");
		// Mods 列表里的名字（引擎不查文本表，靠 KDDrawMods hook 每次画之前改写）
		textOr("KDSelfKeyModName", "SelfKey");
		// 角标本身的两种写法（同时是配置项里显示并保存的值），eval 期先落英文
		markLabels();
	}

	/** 补配置默认值（eval 早于 KDLoadModSettings，脚本里写的默认值会被覆盖） */
	function ensureConfigDefaults() {
		try {
			if (typeof KDModSettings !== "object" || KDModSettings === null) return;
			var tab = KDModSettings[MOD_ID];
			if (!tab || typeof tab !== "object") {
				tab = {};
				KDModSettings[MOD_ID] = tab;
			}
			for (var k in DEFAULTS) {
				if (Object.prototype.hasOwnProperty.call(DEFAULTS, k) && tab[k] === undefined) {
					tab[k] = DEFAULTS[k];
				}
			}
			logDebug("配置默认值已补齐：" + JSON.stringify(tab));
		} catch (err) {
			logError("ensureConfigDefaults", err);
		}
	}

	function resetRuntimeContext(reason) {
		try {
			state.selfCtx = 0;
			state.doorCtx = 0;
			state.unlinkCtx = 0;
			state.pending = null;
			state.unlockCtx = null;
			logDebug("运行时上下文已复位（" + reason + "）");
		} catch (err) {
			logError("resetRuntimeContext", err);
		}
	}

	function registerEvents() {
		try {
			if (typeof KDEventMapGeneric !== "object" || !KDEventMapGeneric) {
				logError("registerEvents", "找不到 KDEventMapGeneric，事件不会注册。");
				return;
			}

			// 引擎的通用事件分发没有 try/catch：处理器异常会打断整帧，全部自包 try/catch
			KDEventMapGeneric["afterModSettingsLoad"] = KDEventMapGeneric["afterModSettingsLoad"] || {};
			KDEventMapGeneric["afterModSettingsLoad"]["KDSelfKey"] = function () {
				try {
					ensureConfigDefaults();
					// 绘制入口缺失时的兜底；正常路径由 KDDrawMods hook 在画列表前改
					localizeModListName();
				} catch (err) { logError("event/afterModSettingsLoad", err); }
			};

			KDEventMapGeneric["afterLoadGame"] = KDEventMapGeneric["afterLoadGame"] || {};
			KDEventMapGeneric["afterLoadGame"]["KDSelfKey"] = function () {
				try {
					// P2-4：读档时 pending 若仍有残留（理论情况；正常流程里它是同 tick 邻接消费的瞬态），
					// 采用与 tick 兜底一致的“按原版补扣”方向，而不是静默丢弃（丢弃会漏扣一次钥匙）。
					flushPending("load");
					resetRuntimeContext("afterLoadGame");
				} catch (err) { logError("event/afterLoadGame", err); }
			};

			KDEventMapGeneric["afterNewGame"] = KDEventMapGeneric["afterNewGame"] || {};
			KDEventMapGeneric["afterNewGame"]["KDSelfKey"] = function () {
				try { resetRuntimeContext("afterNewGame"); } catch (err) { logError("event/afterNewGame", err); }
			};

			// 兜底：万一 pending 没被紧邻的 KinkyDungeonLock 消费（未知路径/其它 Mod 干扰），
			// 在下一回合按原版语义补扣，避免“白嫖”。
			KDEventMapGeneric["tick"] = KDEventMapGeneric["tick"] || {};
			KDEventMapGeneric["tick"]["KDSelfKey"] = function () {
				try {
					var p = state.pending;
					if (p && p.tick !== safeTick()) flushPending("tick-stale");
				} catch (err) {
					logError("event/tick", err);
				}
			};

			// v1.1 显示层①：束缚具悬停面板追加一行（官方事件；extraLines 由原版绘制）
			KDEventMapGeneric["drawSGTooltip"] = KDEventMapGeneric["drawSGTooltip"] || {};
			KDEventMapGeneric["drawSGTooltip"]["KDSelfKey"] = function (e, data) {
				try {
					if (!getSetting("KDSelfKeyShowTooltip", DEFAULTS.KDSelfKeyShowTooltip)) return;
					if (!data || !data.item || !data.extraLines || !data.extraLineColor) return;
					var st = displayState(data.item);
					if (st === 1) {
						data.extraLines.push(textOr("KDSelfKeyTooltipValid", "Self-lock: unlocking costs no key (still needs at least 1 key)"));
						data.extraLineColor.push("#88FFAA");
					} else if (st === 2 && data.item.lock) {
						// 只在“确实有一把锁、但不是自己上的”时提示失效；无锁的自缚穿戴只是还没上锁。
						// 文案不写“照常消耗”：Purple/None 等锁本来就不走钥匙，写死会不准确。
						data.extraLines.push(textOr("KDSelfKeyTooltipStale", "Self-worn, but the lock was replaced by something else: no free unlock"));
						data.extraLineColor.push("#CCCCCC");
					}
				} catch (err) {
					logError("event/drawSGTooltip", err);
				}
			};

			// v1.1 显示层②：状态栏计数（官方事件；stats 由原版 KDDrawBuffIcons 绘制）
			KDEventMapGeneric["drawBuffIcons"] = KDEventMapGeneric["drawBuffIcons"] || {};
			KDEventMapGeneric["drawBuffIcons"]["KDSelfKey"] = function (e, data) {
				try {
					if (!getSetting("KDSelfKeyShowCounter", DEFAULTS.KDSelfKeyShowCounter)) return;
					if (!data || !data.stats) return;
					var n = countSelfLocks();
					if (!n) return;
					if (data.stats.KDSelfKeyCount) return; // 防御：已有同名条目就不重复加
					data.stats.KDSelfKeyCount = {
						text: textOr("KDSelfKeyCounterDesc", "Self-lock: unlocking costs no key (number = active self-locks)"),
						icon: "restraintblock",   // 用原版已有图标，避免新增资源文件
						count: "" + n,
						category: "status",
						color: "#BFFFCF",
						bgcolor: "#333333",
						priority: 0
					};
				} catch (err) {
					logError("event/drawBuffIcons", err);
				}
			};
		} catch (err) {
			logError("registerEvents", err);
		}
	}

	// ========================================================================
	// 11. doctor() / 调试句柄
	// ========================================================================

	function configSnapshot() {
		var out = {};
		for (var k in DEFAULTS) {
			if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) {
				out[k] = getSetting(k, DEFAULTS[k]);
			}
		}
		return out;
	}

	function markerStats() {
		var out = {
			wornCount: 0,
			selfWorn: [],
			selfLock: [],
			both: [],
			selfWornCount: 0,
			selfLockCount: 0,
			bothCount: 0
		};
		try {
			var list = wornList();
			for (var i = 0; i < list.length; i++) {
				var it = list[i] && list[i].item;
				if (!it) continue;
				out.wornCount++;
				var worn = dataGet(it, KEY_SELF_WORN) == 1;
				var lock = dataGet(it, KEY_SELF_LOCK) == 1;
				if (worn) { out.selfWornCount++; out.selfWorn.push(it.name + (it.lock ? "(" + it.lock + ")" : "")); }
				if (lock) { out.selfLockCount++; out.selfLock.push(it.name + (it.lock ? "(" + it.lock + ")" : "")); }
				if (worn && lock) out.both.push(it.name + (it.lock ? "(" + it.lock + ")" : ""));
			}
			out.bothCount = out.both.length;
		} catch (err) {
			logError("markerStats", err);
		}
		return out;
	}

	function hooksSnapshot() {
		function same(fn) {
			try { return typeof fn === "function"; } catch (e) { return false; }
		}
		return {
			KinkyDungeonRemoveKeysUnlock: same(HOOK.removeKeys) && KinkyDungeonRemoveKeysUnlock === HOOK.removeKeys,
			KinkyDungeonLock: same(HOOK.lock) && KinkyDungeonLock === HOOK.lock,
			KinkyDungeonUnlockAttempt: same(HOOK.unlockAttempt) && KinkyDungeonUnlockAttempt === HOOK.unlockAttempt,
			KDDoEquipDelayed: same(HOOK.equip) && KDDoEquipDelayed === HOOK.equip,
			KDDoEquipGenericDelayed: same(HOOK.equipGeneric) && KDDoEquipGenericDelayed === HOOK.equipGeneric,
			KinkyDungeonUnLinkItem: same(HOOK.unlinkItem) && KinkyDungeonUnLinkItem === HOOK.unlinkItem,
			KDInputTypes_lock: (function () {
				try { return same(HOOK.lockInput) && typeof KDInputTypes === "object" && KDInputTypes["lock"] === HOOK.lockInput; }
				catch (e) { return false; }
			})(),
			KDGetItemName: same(HOOK.itemName) && KDGetItemName === HOOK.itemName,
			KDDrawModConfigs: same(HOOK.drawConfigs) && KDDrawModConfigs === HOOK.drawConfigs,
			KDDrawMods: same(HOOK.drawMods) && KDDrawMods === HOOK.drawMods
		};
	}

	/** 自检：在浏览器控制台执行 KDSelfKey.doctor() */
	function doctor() {
		var report = {};
		try {
			report = {
				mod: MOD_ID,
				version: VERSION,
				targetGameVersion: TARGET_GAME_VERSION,
				hooks: hooksSnapshot(),
				missingGlobals: state.missing.slice(),
				config: configSnapshot(),
				runtime: {
					selfCtx: state.selfCtx,
					doorCtx: state.doorCtx,
					unlinkCtx: state.unlinkCtx,
					pending: state.pending ? { lock: state.pending.lock, tick: state.pending.tick } : null,
					unlockCtx: state.unlockCtx && state.unlockCtx.item
						? { item: state.unlockCtx.item.name, id: state.unlockCtx.item.id } : null
				},
				markers: markerStats(),
				display: {
					KDSelfKeyShowNameMark: getSetting("KDSelfKeyShowNameMark", DEFAULTS.KDSelfKeyShowNameMark),
					KDSelfKeyShowLockMsg: getSetting("KDSelfKeyShowLockMsg", DEFAULTS.KDSelfKeyShowLockMsg),
					KDSelfKeyShowTooltip: getSetting("KDSelfKeyShowTooltip", DEFAULTS.KDSelfKeyShowTooltip),
					KDSelfKeyShowCounter: getSetting("KDSelfKeyShowCounter", DEFAULTS.KDSelfKeyShowCounter),
					KDSelfKeyNameMark: nameMarkText(),
					KDSelfKeyMarkPrefix: getSetting("KDSelfKeyMarkPrefix", DEFAULTS.KDSelfKeyMarkPrefix),
					markedCount: countSelfLocks()
				},
				stats: JSON.parse(JSON.stringify(state.stats)),
				lastDecision: state.lastDecision
			};
		} catch (err) {
			logError("doctor", err);
			report = { mod: MOD_ID, error: String(err) };
		}

		// 同时打印一份便于肉眼排查的摘要
		try {
			var hs = report.hooks || {};
			var lines = [
				LOG_PREFIX + "v" + VERSION + "（目标游戏 v" + TARGET_GAME_VERSION + "）",
				"hooks: " + Object.keys(hs).map(function (k) { return k + "=" + hs[k]; }).join(", "),
				"config: " + JSON.stringify(report.config),
				"missing: " + (report.missingGlobals && report.missingGlobals.length ? report.missingGlobals.join(", ") : "无"),
				"markers: " + JSON.stringify(report.markers),
				"display: " + JSON.stringify(report.display),
				"stats: " + JSON.stringify(report.stats),
				"lastDecision: " + JSON.stringify(report.lastDecision || null)
			];
			console.log(lines.join("\n"));
		} catch (e) { /* ignore */ }

		return report;
	}

	var api = {
		__installed: true,
		modId: MOD_ID,
		version: VERSION,
		targetGameVersion: TARGET_GAME_VERSION,
		doctor: doctor,
		stats: function () { try { return JSON.parse(JSON.stringify(state.stats)); } catch (e) { return {}; } },
		config: configSnapshot,
		decisions: function () { return state.decisions.slice(); },
		lastDecision: function () { return state.lastDecision; }
	};

	// ========================================================================
	// 12. 启动
	// ========================================================================

	try {
		registerTexts();
	} catch (err) {
		logError("bootstrap/registerTexts", err);
	}

	try {
		installHooks();
	} catch (err) {
		logError("bootstrap/installHooks", err);
	}

	try {
		registerConfig();
	} catch (err) {
		logError("bootstrap/registerConfig", err);
	}

	try {
		registerEvents();
	} catch (err) {
		logError("bootstrap/registerEvents", err);
	}

	try {
		if (typeof window !== "undefined" && window) {
			window.KDSelfKey = api;
			window.KD_SELFKEY = api;
		}
	} catch (err) {
		logError("bootstrap/expose", err);
	}

	try {
		console.log(LOG_PREFIX + "已加载 v" + VERSION + "。控制台输入 KDSelfKey.doctor() 自检。");
	} catch (e) { /* ignore */ }
})();
