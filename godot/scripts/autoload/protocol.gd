## Shared protocol constants mirroring src/protocol.ts
## Autoload name: Protocol
extends Node

const MIN_PLAYERS := 6
const MAX_PLAYERS := 12
const MAX_CHAT_LEN := 200
const MAX_NAME_LEN := 12

const ROLE_NAMES := {
	"werewolf": "狼人",
	"seer": "預言家",
	"witch": "女巫",
	"hunter": "獵人",
	"villager": "平民",
}

const WINNER_NAMES := {
	"werewolves": "狼人陣營獲勝",
	"villagers": "好人陣營獲勝",
}

const ERROR_TEXT := {
	"room_full": "房間已滿（12 人上限）。",
	"game_started": "遊戲已經開始，無法入座。",
	"not_host": "只有房主可以做這件事。",
	"wrong_phase": "現在的階段不能做這個動作。",
	"bad_player_count": "需要 6–12 人才能開局。",
	"not_in_room": "你不在這間房裡。",
	"not_joined": "尚未加入房間。",
	"not_alive": "你已出局，遺言也說完了。",
	"wrong_role": "你的身分不能做這個動作。",
	"bad_target": "這個目標無效。",
	"already_voted": "你已經投過票了，本輪不能改票。",
	"already_acted": "你今晚已經行動過了。",
	"no_potion": "這瓶藥已經用掉了（或無人可救）。",
	"runoff_candidate": "你是決選候選人，本輪不能投票。",
	"rate_limited": "說話太快了，稍等一下再送。",
	"bad_message": "訊息格式錯誤。",
	"bad_session": "這個座位的憑證無效。",
	"unknown_message": "不支援的訊息。",
	"room_gone": "房間不存在或已關閉。",
	"room_closed": "房間已因閒置太久而關閉。",
	"offline": "離線模式僅能看大廳與聊天，無法開局（請取消勾選離線試玩後連線）。",
}


func error_message(code: String) -> String:
	return ERROR_TEXT.get(code, "發生錯誤：%s" % code)


func role_name(role: String) -> String:
	return ROLE_NAMES.get(role, role)


func winner_name(winner: String) -> String:
	return WINNER_NAMES.get(winner, winner)
