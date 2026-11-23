/**
 * 自进化（她自己的时间）的常量。
 *
 * 与 `memory/constants.ts` 同一条纪律：**数据契约相关的字面量只在这里出现一次**
 * （文档键写进存储、任务标题写进调度、唤醒标记写进消息来源判据）。
 * @module humanity/evolution/constants
 */

/** 状态文档的键（存在文档表里，与人格/时钟同一张表）。 */
export const EVOLUTION_DOC_KEY = 'humanity-evolution'

/** 她的房间在 `$DSH_HOME` 下的相对路径：她写的东西、以后的作品都落在这儿。 */
export const ROOM_DIR = 'humanity/room'

/** 房间里那个调度任务的标题（你在 DSH 的任务管理器里看到的就是它）。 */
export const ROOM_TASK_TITLE = '她自己的时间'

/**
 * 醒来提示词的标记。
 *
 * 为什么需要它：调度消息进会话时来源标记是 `schedule`，但你我也可能给自己排提醒。
 * 只有带这个标记的那条才是"她自己的时间"，其余一律不算。
 */
export const WAKE_MARKER = '[你自己的时间]'

/** 到达当日上限后，下一次排在第二天早上的几点（按她的时区）。 */
export const NEXT_MORNING_HOUR = 8

/** 排下一次的最小间隔（秒）：DSH 单任务最小投递间隔是 60 秒。 */
export const MIN_GAP_SECONDS = 60

/**
 * 房间还没排上时，隔多久借一轮对话再试一次（毫秒）。
 *
 * 为什么需要重试：真机上会话服务可能比我们挂得**晚**（store 就绪那一刻还看不见它）。
 * 装配期那一次失败如果不重试，"她没有自己的日子"就会一直停在那儿，而没人知道该等一等。
 */
export const RETRY_ARM_AFTER_MS = 2 * 60 * 1000
