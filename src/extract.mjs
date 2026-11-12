const number=value=>{
  if(/^\d+$/.test(value))return Number(value);
  const digits={零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  if(value.includes('十')){const [a,b]=value.split('十');return (a?digits[a]:1)*10+(b?digits[b]:0);}
  return digits[value]??NaN;
};
const tokens=text=>text.match(/20\d{2}[-/年]\d{1,2}[-/月]\d{1,2}日?|\d{1,2}月\d{1,2}日?|今天|明天|后天|今晚|(?:下周|本周|这周|周|下星期|本星期|星期)[一二三四五六日天]/g)??[];
export function parseDue(text,sentAt) {
  const changed=text.match(/(?:改到|改为|改至|调整为|变更为)([\s\S]*)/);
  const segment=changed?changed[1]:text;
  const clocks=[...segment.matchAll(/(上午|下午|晚上|中午|凌晨|晚)?\s*(?:(\d{1,2})[:：](\d{2})|([零〇一二两三四五六七八九十\d]{1,3})点(半|[零〇一二两三四五六七八九十\d]{1,3}分?)?)/g)];
  if(clocks.length!==1||new Set(tokens(segment)).size!==1)return null;
  const clock=clocks[0];let hour=number(clock[2]??clock[4]);
  const minute=clock[3]?Number(clock[3]):clock[5]==='半'?30:clock[5]?number(clock[5].replace('分','')):0;
  if(['下午','晚上','晚'].includes(clock[1])||(!clock[1]&&/今晚/.test(segment.slice(0,clock.index))))hour=hour<12?hour+12:hour;
  if(clock[1]==='中午'&&hour<11)hour+=12;
  if(clock[1]==='凌晨'&&hour===12)hour=0;
  if(!Number.isFinite(hour)||!Number.isFinite(minute)||hour>23||minute>59)return null;
  const source=new Date(Number(sentAt)+8*3600000);
  const full=segment.match(/(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})日?/),md=segment.match(/(\d{1,2})月(\d{1,2})日?/);
  const relative=segment.match(/(今天|明天|后天|今晚)/),weekday=segment.match(/(下周|本周|这周|周|下星期|本星期|星期)([一二三四五六日天])/);
  let year=source.getUTCFullYear(),month=source.getUTCMonth()+1,day=source.getUTCDate();
  if(full||md){year=full?Number(full[1]):year;month=Number(full?full[2]:md[1]);day=Number(full?full[3]:md[2]);}
  else if(relative)day+=({今天:0,今晚:0,明天:1,后天:2}[relative[1]]);
  else if(weekday){const target={一:1,二:2,三:3,四:4,五:5,六:6,日:0,天:0}[weekday[2]];
    if(['周','星期'].includes(weekday[1])){let delta=(target-source.getUTCDay()+7)%7;const due=Date.UTC(year,month-1,day+delta,hour-8,minute);if(due<=sentAt)delta+=7;day+=delta;}
    else day=day-((source.getUTCDay()+6)%7)+(target===0?6:target-1)+(/下/.test(weekday[1])?7:0);
  }else return null;
  const ms=Date.UTC(year,month-1,day,hour-8,minute);
  if(full||md){const local=new Date(ms+8*3600000);if(local.getUTCFullYear()!==year||local.getUTCMonth()+1!==month||local.getUTCDate()!==day)return null;}
  return new Date(ms).toISOString();
}
export function extract(text,{sentAt=Date.now()}={}) {
  const clean=text.replace(/\s+/g,' ').trim();let category='chat';
  if(/实习|内推|校招|简历|投递/.test(clean))category='intern';
  else if(/作业|课程报告|实验报告|学习通|论文|练习|复习/.test(clean))category='homework';
  else if(/彩排|比赛|考试|活动|会议|讲座|训练赛|签到/.test(clean))category='activity';
  else if(/通知|调课|教室|停课|调整|改期|截止|提交|报名|补交|缴费/.test(clean))category='notice';
  const cancelled=/取消|无需.{0,5}(?:参加|提交|交)|不用.{0,5}(?:参加|提交|交)|不必.{0,5}(?:参加|提交|交)/.test(clean);
  const question=/[？?]$/.test(clean)||/(?:吗|么|嘛|了没)$/.test(clean);
  const actionable=category!=='chat'&&!cancelled&&!question&&/提交|完成|报名|参加|到场|携带|带耳机|投递|缴费|签到|作业|彩排|考试|训练赛|截止|务必|必须|补交|请.{0,8}(?:交|填|带|到)|尽快交/.test(clean);
  const dueAt=actionable?parseDue(clean,sentAt):null;
  const audienceHint=actionable&&/尚未|还未|未提交|未交|未完成|有意向|有需要|需补选/.test(clean)?'仅针对部分成员，请确认这件事与你有关。':'';
  const uncertainty=actionable&&!dueAt?'日期或时间不完整或存在多个时间，请核对原消息。':dueAt&&Date.parse(dueAt)<=sentAt?'提取时间已过，请确认。':'';
  const assignment=clean.match(/作业\s*\d+/);
  const title=assignment?'完成'+assignment[0]:category==='activity'&&/彩排/.test(clean)?'参加彩排':clean.replace(/^(大家注意|同学们|通知)[，：: ]*/,'').slice(0,70);
  return {category,actionable,title,dueAt,audienceHint,uncertainty,text:clean.slice(0,240),cancelled,extractor:'rules'};
}

