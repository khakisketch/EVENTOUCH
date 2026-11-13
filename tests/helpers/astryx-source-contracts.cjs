'use strict';

const React = require('../../apps/web/node_modules/react');

// Source-only contracts may inspect the native element contract emitted by
// these exact adapters while retaining their native props and event handlers.
function normalizeProductActionTags(source) {
  return source
    .replace(/<ProductButton\b/g, '<button')
    .replace(/<\/ProductButton>/g, '</button>')
    .replace(/<ProductLink\b/g, '<Link')
    .replace(/<\/ProductLink>/g, '</Link>');
}

function productActionImports() {
  return {
    './ui/ProductButton': { default: (props) => React.createElement('button', props, props.children) },
    './ui/ProductLink': { default: (props) => React.createElement('a', props, props.children) },
    './ui/ProductNotice': { default: ({ kind, children, ...props }) => React.createElement(kind === 'error' ? 'div' : 'div', { ...props, role: kind === 'error' ? 'alert' : 'status' }, children) },
  };
}

module.exports = { normalizeProductActionTags, productActionImports };
