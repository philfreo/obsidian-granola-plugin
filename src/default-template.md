---
granola_id: {{granola_id}}
granola_url: {{granola_url}}
title: "{{granola_title}}"
date: {{granola_date}}
type: meeting
{{#granola_meeting_transcript}}
meeting_transcript: "[[{{granola_meeting_transcript}}]]"
{{/granola_meeting_transcript}}
{{#granola_folders}}
folders:
{{granola_folders_linked_list}}
{{/granola_folders}}
attendees:
{{granola_attendees_linked_list}}
tags:
  - meeting
  - granola
---
{{#granola_private_notes}}## Notes

{{granola_private_notes}}
{{/granola_private_notes}}
{{#granola_enhanced_notes}}## Summary

{{#granola_duration_formatted}}{{granola_start_time}}-{{granola_end_time}} ({{granola_duration_formatted}})

{{/granola_duration_formatted}}{{granola_enhanced_notes}}
{{/granola_enhanced_notes}}
