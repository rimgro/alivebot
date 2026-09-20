/**
 * Subset of the Telegram Bot API object model that alive actually uses.
 *
 * Deliberately hand-written instead of generated: it keeps the public surface
 * small and makes the update → event mapping in `update.ts` easy to audit.
 * Everything optional in the Bot API is optional here.
 */

export interface TelegramUser {
	id: number;
	is_bot: boolean;
	first_name: string;
	last_name?: string;
	username?: string;
	language_code?: string;
	is_premium?: boolean;
}

export type TelegramChatType = "private" | "group" | "supergroup" | "channel";

export interface TelegramChat {
	id: number;
	type: TelegramChatType;
	title?: string;
	username?: string;
	first_name?: string;
	last_name?: string;
	description?: string;
	invite_link?: string;
	bio?: string;
	is_forum?: boolean;
	pinned_message?: TelegramMessage;
}

export interface TelegramMessageEntity {
	type: string;
	offset: number;
	length: number;
	url?: string;
	user?: TelegramUser;
	language?: string;
}

export interface TelegramFile {
	file_id: string;
	file_unique_id: string;
	file_size?: number;
	file_path?: string;
}

export interface TelegramPhotoSize extends TelegramFile {
	width: number;
	height: number;
}

export interface TelegramDocument extends TelegramFile {
	file_name?: string;
	mime_type?: string;
	thumbnail?: TelegramPhotoSize;
}

export interface TelegramAudio extends TelegramFile {
	duration: number;
	performer?: string;
	title?: string;
	file_name?: string;
	mime_type?: string;
}

export interface TelegramVoice extends TelegramFile {
	duration: number;
	mime_type?: string;
}

export interface TelegramVideo extends TelegramFile {
	width: number;
	height: number;
	duration: number;
	file_name?: string;
	mime_type?: string;
}

export interface TelegramSticker extends TelegramFile {
	width: number;
	height: number;
	emoji?: string;
	set_name?: string;
	is_animated?: boolean;
	is_video?: boolean;
}

export interface TelegramLocation {
	longitude: number;
	latitude: number;
	horizontal_accuracy?: number;
}

export interface TelegramContact {
	phone_number: string;
	first_name: string;
	last_name?: string;
	user_id?: number;
}

export interface TelegramPollOption {
	text: string;
	voter_count: number;
}

export interface TelegramPoll {
	id: string;
	question: string;
	options: TelegramPollOption[];
	total_voter_count: number;
	is_closed: boolean;
	is_anonymous: boolean;
	type: string;
	allows_multiple_answers: boolean;
}

export interface TelegramMessage {
	message_id: number;
	message_thread_id?: number;
	from?: TelegramUser;
	sender_chat?: TelegramChat;
	date: number;
	edit_date?: number;
	chat: TelegramChat;
	reply_to_message?: TelegramMessage;
	forward_origin?: {
		type: string;
		date?: number;
		sender_user?: TelegramUser;
		sender_user_name?: string;
		sender_chat?: TelegramChat;
		chat?: TelegramChat;
		message_id?: number;
	};
	text?: string;
	entities?: TelegramMessageEntity[];
	caption?: string;
	caption_entities?: TelegramMessageEntity[];
	photo?: TelegramPhotoSize[];
	document?: TelegramDocument;
	audio?: TelegramAudio;
	voice?: TelegramVoice;
	video?: TelegramVideo;
	sticker?: TelegramSticker;
	location?: TelegramLocation;
	contact?: TelegramContact;
	poll?: TelegramPoll;
	new_chat_members?: TelegramUser[];
	left_chat_member?: TelegramUser;
	new_chat_title?: string;
	pinned_message?: TelegramMessage;
	is_topic_message?: boolean;
	via_bot?: TelegramUser;
	web_app_data?: { data: string; button_text: string };
}

export interface TelegramCallbackQuery {
	id: string;
	from: TelegramUser;
	message?: TelegramMessage;
	data?: string;
	chat_instance: string;
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
	channel_post?: TelegramMessage;
	edited_channel_post?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
	my_chat_member?: {
		chat: TelegramChat;
		from: TelegramUser;
		date: number;
		old_chat_member: TelegramChatMember;
		new_chat_member: TelegramChatMember;
	};
}

export interface TelegramChatMember {
	status: "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";
	user: TelegramUser;
	custom_title?: string;
	is_anonymous?: boolean;
	until_date?: number;
}

export interface TelegramApiEnvelope<T> {
	ok: boolean;
	result?: T;
	error_code?: number;
	description?: string;
	parameters?: {
		retry_after?: number;
		migrate_to_chat_id?: number;
	};
}

export interface TelegramSentMessage {
	message_id: number;
	date: number;
	chat: TelegramChat;
	text?: string;
}
