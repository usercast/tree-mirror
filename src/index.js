const TreeMirror = (() => {
    class TreeMirror {
        constructor(root, delegate) {
            this.root = root;
            this.delegate = delegate;
            this.idMap = {};
        }

        initialize(rootId, children) {
            this.idMap[rootId] = this.root;
            for (let i = 0; i < children.length; i++)
                this.deserializeNode(children[i], this.root);
        }

        applyChanged(removed, addedOrMoved, attributes, text) {
            const _this = this;
            // NOTE: Applying the changes can result in an attempting to add a child
            // to a parent which is presently an ancestor of the parent. This can occur
            // based on random ordering of moves. The way we handle this is to first
            // remove all changed nodes from their parents, then apply.
            addedOrMoved.forEach(data => {
                const node = _this.deserializeNode(data);
                const parent = _this.deserializeNode(data.parentNode);
                const previous = _this.deserializeNode(data.previousSibling);
                if (node.parentNode)
                    node.parentNode.removeChild(node);
            });
            removed.forEach(data => {
                const node = _this.deserializeNode(data);
                if (node.parentNode)
                    node.parentNode.removeChild(node);
            });
            addedOrMoved.forEach(data => {
                const node = _this.deserializeNode(data);
                const parent = _this.deserializeNode(data.parentNode);
                const previous = _this.deserializeNode(data.previousSibling);
                parent.insertBefore(node, previous ? previous.nextSibling : parent.firstChild);
            });
            attributes.forEach(data => {
                const node = _this.deserializeNode(data);
                Object.keys(data.attributes).forEach(attrName => {
                    const newVal = data.attributes[attrName];
                    if (newVal === null) {
                        node.removeAttribute(attrName);
                    }
                    else {
                        if (!_this.delegate ||
                            !_this.delegate.setAttribute ||
                            !_this.delegate.setAttribute(node, attrName, newVal)) {
                            node.setAttribute(attrName, newVal);
                        }
                    }
                });
            });
            text.forEach(data => {
                const node = _this.deserializeNode(data);
                node.textContent = data.textContent;
            });
            removed.forEach(({id}) => {
                delete _this.idMap[id];
            });
        }

        deserializeNode(nodeData, parent) {
            const _this = this;
            if (nodeData === null)
                return null;
            let node = this.idMap[nodeData.id];
            if (node)
                return node;
            let doc = this.root.ownerDocument;
            if (doc === null)
                doc = this.root;
            switch (nodeData.nodeType) {
                case Node.COMMENT_NODE:
                    node = doc.createComment(nodeData.textContent);
                    break;
                case Node.TEXT_NODE:
                    node = doc.createTextNode(nodeData.textContent);
                    break;
                case Node.DOCUMENT_TYPE_NODE:
                    node = doc.implementation.createDocumentType(nodeData.name, nodeData.publicId, nodeData.systemId);
                    break;
                case Node.ELEMENT_NODE:
                    if (this.delegate && this.delegate.createElement)
                        node = this.delegate.createElement(nodeData.tagName);
                    if (!node)
                        node = doc.createElement(nodeData.tagName);
                    Object.keys(nodeData.attributes).forEach(name => {
                        if (!_this.delegate ||
                            !_this.delegate.setAttribute ||
                            !_this.delegate.setAttribute(node, name, nodeData.attributes[name])) {
                            node.setAttribute(name, nodeData.attributes[name]);
                        }
                    });
                    break;
            }
            if (!node)
                throw "ouch";
            this.idMap[nodeData.id] = node;
            if (parent)
                parent.appendChild(node);
            if (nodeData.childNodes) {
                for (let i = 0; i < nodeData.childNodes.length; i++)
                    this.deserializeNode(nodeData.childNodes[i], node);
            }
            return node;
        }
    }

    return TreeMirror;
})();

const TreeMirrorClient = (() => {
    class TreeMirrorClient {
        constructor(target, mirror, testingQueries) {
            const _this = this;
            this.target = target;
            this.mirror = mirror;
            this.nextId = 1;
            this.knownNodes = new MutationSummary.NodeMap();
            const rootId = this.serializeNode(target).id;
            const children = [];
            for (let child = target.firstChild; child; child = child.nextSibling)
                children.push(this.serializeNode(child, true));
            this.mirror.initialize(rootId, children);
            const self = this;
            let queries = [{ all: true }];
            if (testingQueries)
                queries = queries.concat(testingQueries);
            this.mutationSummary = new MutationSummary({
                rootNode: target,
                callback(summaries) {
                    _this.applyChanged(summaries);
                },
                queries
            });
        }

        disconnect() {
            if (this.mutationSummary) {
                this.mutationSummary.disconnect();
                this.mutationSummary = undefined;
            }
        }

        rememberNode(node) {
            const id = this.nextId++;
            this.knownNodes.set(node, id);
            return id;
        }

        forgetNode(node) {
            this.knownNodes.delete(node);
        }

        serializeNode(node, recursive) {
            if (node === null)
                return null;
            const id = this.knownNodes.get(node);
            if (id !== undefined) {
                return { id };
            }
            const data = {
                nodeType: node.nodeType,
                id: this.rememberNode(node)
            };
            switch (data.nodeType) {
                case Node.DOCUMENT_TYPE_NODE:
                    const docType = node;
                    data.name = docType.name;
                    data.publicId = docType.publicId;
                    data.systemId = docType.systemId;
                    break;
                case Node.COMMENT_NODE:
                case Node.TEXT_NODE:
                    data.textContent = node.textContent;
                    break;
                case Node.ELEMENT_NODE:
                    const elm = node;
                    data.tagName = elm.tagName;
                    data.attributes = {};
                    for (let i = 0; i < elm.attributes.length; i++) {
                        const attr = elm.attributes[i];
                        data.attributes[attr.name] = attr.value;
                    }
                    if (recursive && elm.childNodes.length) {
                        data.childNodes = [];
                        for (let child = elm.firstChild; child; child = child.nextSibling)
                            data.childNodes.push(this.serializeNode(child, true));
                    }
                    break;
            }
            return data;
        }

        serializeAddedAndMoved(added, reparented, reordered) {
            const _this = this;
            const all = added.concat(reparented).concat(reordered);
            const parentMap = new MutationSummary.NodeMap();
            all.forEach(node => {
                const parent = node.parentNode;
                let children = parentMap.get(parent);
                if (!children) {
                    children = new MutationSummary.NodeMap();
                    parentMap.set(parent, children);
                }
                children.set(node, true);
            });
            const moved = [];
            parentMap.keys().forEach(parent => {
                const children = parentMap.get(parent);
                var keys = children.keys();
                while (keys.length) {
                    let node = keys[0];
                    while (node.previousSibling && children.has(node.previousSibling))
                        node = node.previousSibling;
                    while (node && children.has(node)) {
                        const data = _this.serializeNode(node);
                        data.previousSibling = _this.serializeNode(node.previousSibling);
                        data.parentNode = _this.serializeNode(node.parentNode);
                        moved.push(data);
                        children.delete(node);
                        node = node.nextSibling;
                    }
                    var keys = children.keys();
                }
            });
            return moved;
        }

        serializeAttributeChanges(attributeChanged) {
            const _this = this;
            const map = new MutationSummary.NodeMap();
            Object.keys(attributeChanged).forEach(attrName => {
                attributeChanged[attrName].forEach(element => {
                    let record = map.get(element);
                    if (!record) {
                        record = _this.serializeNode(element);
                        record.attributes = {};
                        map.set(element, record);
                    }
                    record.attributes[attrName] = element.getAttribute(attrName);
                });
            });
            return map.keys().map(node => map.get(node));
        }

        applyChanged(summaries) {
            const _this = this;
            const summary = summaries[0];
            const removed = summary.removed.map(node => _this.serializeNode(node));
            const moved = this.serializeAddedAndMoved(summary.added, summary.reparented, summary.reordered);
            const attributes = this.serializeAttributeChanges(summary.attributeChanged);
            const text = summary.characterDataChanged.map(node => {
                const data = _this.serializeNode(node);
                data.textContent = node.textContent;
                return data;
            });
            this.mirror.applyChanged(removed, moved, attributes, text);
            summary.removed.forEach(node => {
                _this.forgetNode(node);
            });
        }
    }

    return TreeMirrorClient;
})();

export { TreeMirror, TreeMirrorClient };
