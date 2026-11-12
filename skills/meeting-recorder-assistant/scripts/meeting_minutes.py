"""
Meeting Minutes Generator - Create structured meeting summaries
Author: ClawHub Skill
"""

import json
import re
from datetime import datetime
from typing import Dict, List, Optional


def generate_minutes(transcript_path: str, output_format: str = "markdown") -> Dict:
    """
    Generate meeting minutes from transcript.
    
    Args:
        transcript_path: Path to transcript file (JSON or TXT)
        output_format: Output format ("markdown" or "json")
    
    Returns:
        Dictionary with meeting minutes structure
    """
    # Read transcript
    transcript_data = read_transcript(transcript_path)
    
    if "error" in transcript_data:
        return transcript_data
    
    text = transcript_data.get("text", "")
    
    # Extract components
    attendees = extract_attendees(text)
    summary = generate_summary(text)
    action_items = extract_action_items(text)
    decisions = extract_decisions(text)
    topics = extract_topics(text)
    
    minutes = {
        "meeting_date": datetime.now().isoformat(),
        "attendees": attendees,
        "summary": summary,
        "topics_discussed": topics,
        "decisions_made": decisions,
        "action_items": action_items,
        "next_meeting": extract_next_meeting(text)
    }
    
    if output_format == "markdown":
        return {
            "format": "markdown",
            "content": format_as_markdown(minutes),
            "data": minutes
        }
    
    return minutes


def read_transcript(transcript_path: str) -> Dict:
    """Read transcript from file"""
    try:
        if transcript_path.endswith('.json'):
            with open(transcript_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        else:
            with open(transcript_path, 'r', encoding='utf-8') as f:
                return {"text": f.read()}
    except Exception as e:
        return {"error": f"Failed to read transcript: {e}"}


def extract_attendees(text: str) -> List[str]:
    """Extract attendee names from transcript"""
    patterns = [
        r'(\w+)[：:]\s*出席',
        r'参会人员[：:]([^\n]+)',
        r'Attendees?[：:]([^\n]+)',
    ]
    
    attendees = []
    for pattern in patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        for match in matches:
            names = re.split(r'[,，、;；]', match)
            attendees.extend([n.strip() for n in names if n.strip()])
    
    # Remove duplicates while preserving order
    seen = set()
    unique_attendees = []
    for a in attendees:
        if a.lower() not in seen:
            seen.add(a.lower())
            unique_attendees.append(a)
    
    return unique_attendees


def generate_summary(text: str) -> str:
    """Generate a brief summary of the meeting"""
    # Simple summarization: take first 2-3 sentences or first 200 chars
    sentences = re.split(r'[.!?。！？]\s*', text)[:3]
    summary = '. '.join(s.strip() for s in sentences if s.strip())
    
    if len(summary) > 300:
        summary = summary[:300] + "..."
    
    return summary if summary else "Meeting discussion captured"


def extract_action_items(text: str) -> List[Dict]:
    """Extract action items from transcript"""
    action_keywords = [
        'action item', 'todo', 'task', '待办', '任务', '行动项',
        '负责', '跟进', '完成', '需要', '必须'
    ]
    
    action_items = []
    lines = text.split('\n')
    
    for line in lines:
        for keyword in action_keywords:
            if keyword in line.lower():
                # Try to extract assignee
                assignee_pattern = r'(\w+)[\s负责跟进]*[:：,，\s]'
                assignees = re.findall(assignee_pattern, line)
                
                item = {
                    "task": line.strip(),
                    "assignee": assignees[0] if assignees else "TBD",
                    "due_date": None,
                    "priority": "medium"
                }
                action_items.append(item)
                break
    
    return action_items[:10]  # Limit to top 10


def extract_decisions(text: str) -> List[str]:
    """Extract decisions made during the meeting"""
    decision_keywords = [
        'decided', 'decision', 'agreed', 'resolved', 'approved',
        '决定', '决议', '确定', '同意', '批准', '通过'
    ]
    
    decisions = []
    lines = text.split('\n')
    
    for line in lines:
        for keyword in decision_keywords:
            if keyword in line.lower():
                decisions.append(line.strip())
                break
    
    return decisions[:5]  # Limit to top 5


def extract_topics(text: str) -> List[str]:
    """Extract main topics discussed"""
    # Simple topic extraction based on sentence importance
    sentences = re.split(r'[.!?。！？]', text)
    topics = []
    
    for sentence in sentences:
        sentence = sentence.strip()
        if len(sentence) > 10 and len(sentence) < 100:
            topics.append(sentence)
    
    return topics[:5]  # Top 5 topics


def extract_next_meeting(text: str) -> Optional[str]:
    """Extract next meeting date/time if mentioned"""
    date_patterns = [
        r'下次会议[：:]\s*([^\n]+)',
        r'next meeting[：:]\s*([^\n]+)',
    ]
    
    for pattern in date_patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        if matches:
            return matches[0].strip()
    
    return None


def format_as_markdown(minutes: Dict) -> str:
    """Format minutes as markdown document"""
    md = f"""# Meeting Minutes

**Date:** {minutes['meeting_date']}

## Attendees

"""
    
    for attendee in minutes['attendees']:
        md += f"- {attendee}\n"
    
    md += f"\n## Summary\n\n{minutes['summary']}\n"
    
    md += "\n## Topics Discussed\n\n"
    for i, topic in enumerate(minutes['topics_discussed'], 1):
        md += f"{i}. {topic}\n"
    
    if minutes['decisions_made']:
        md += "\n## Decisions Made\n\n"
        for decision in minutes['decisions_made']:
            md += f"- {decision}\n"
    
    if minutes['action_items']:
        md += "\n## Action Items\n\n"
        md += "| Task | Assignee | Due Date | Priority |\n"
        md += "|------|----------|----------|----------|\n"
        for item in minutes['action_items']:
            md += f"| {item['task'][:50]}... | {item['assignee']} | {item['due_date'] or 'TBD'} | {item['priority']} |\n"
    
    if minutes['next_meeting']:
        md += f"\n## Next Meeting\n\n{minutes['next_meeting']}\n"
    
    return md


if __name__ == "__main__":
    print("Meeting Minutes Generator")
    print("=" * 50)
