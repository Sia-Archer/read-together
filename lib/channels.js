'use strict';

function readerKey(channel) {
  if (!['codex', 'chatgpt'].includes(channel)) throw new Error('Unknown Books channel');
  return `ai_${channel}`;
}

// Historical records without an unambiguous owner stay in storage, unassigned.
function annotationChannel(annotation) {
  if (['codex', 'chatgpt'].includes(annotation.channel)) return annotation.channel;
  if (annotation.sharedTarget === 'chatgpt') return 'chatgpt';
  if (['home', 'call', 'codex'].includes(annotation.sharedTarget)) return 'codex';
  if (['codex', 'chatgpt'].includes(annotation.source)) return annotation.source;
  return null;
}

function belongsTo(annotation, channel) {
  readerKey(channel);
  return annotationChannel(annotation) === channel;
}

function visibleTo(annotation, channel) {
  readerKey(channel);
  return annotation?.createdBy === 'human' || belongsTo(annotation, channel);
}

function commentChannel(comment, annotation) {
  if (['codex', 'chatgpt'].includes(comment?.source)) return comment.source;
  if (['codex', 'chatgpt'].includes(comment?.channel)) return comment.channel;
  return annotationChannel(annotation);
}

function visibleAnnotation(annotation, channel) {
  if (!visibleTo(annotation, channel)) return null;
  const comments = Array.isArray(annotation.comments) ? annotation.comments : [];
  const first = comments[0];
  const rootIsComment = !String(annotation.note || annotation.comment || '').trim()
    && first?.author === annotation.createdBy && first?.kind !== 'reply';
  return {
    ...annotation,
    comments: comments.flatMap((comment, index) => {
      if (index === 0 && rootIsComment) return [comment];
      return commentChannel(comment, annotation) === channel ? [{ ...comment, kind: 'reply' }] : [];
    }),
  };
}

module.exports = { readerKey, annotationChannel, belongsTo, visibleTo, visibleAnnotation, commentChannel };
