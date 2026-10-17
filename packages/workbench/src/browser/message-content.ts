import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import diff from "highlight.js/lib/languages/diff";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import sql from "highlight.js/lib/languages/sql";
import { renderToString } from "katex";
import { Marked, type MarkedToken, type Token } from "marked";

for (const [name, language] of Object.entries({ bash, diff, json, python, r, sql }))
	hljs.registerLanguage(name, language);

const markdown = new Marked({
	gfm: true,
	extensions: [
		{
			name: "math",
			level: "block",
			start: (source) => source.indexOf("$$"),
			tokenizer(source) {
				const match = /^\$\$\n?([\s\S]+?)\n?\$\$(?:\n|$)/.exec(source);
				if (match) return { type: "math", raw: match[0], text: match[1], display: true };
			},
		},
		{
			name: "math",
			level: "inline",
			start: (source) => source.search(/\$|\\\(/),
			tokenizer(source) {
				const match = /^(?:\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)|\\\(([\s\S]+?)\\\))/.exec(source);
				if (match) return { type: "math", raw: match[0], text: match[1] ?? match[2], display: false };
			},
		},
	],
});

/** Render untrusted Markdown as DOM, never accepting model-supplied HTML or fetching images. */
export function renderMessageContent(container: HTMLElement, text: string): void {
	const document = container.ownerDocument;
	container.classList.add("message-content");
	container.replaceChildren();

	function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, value?: string) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (value !== undefined) node.textContent = value;
		return node;
	}

	function math(source: string, display: boolean): HTMLElement {
		const node = element(display ? "div" : "span", `message-math${display ? " message-math-block" : ""}`);
		node.setAttribute("aria-label", source);
		try {
			// Only library-generated MathML reaches the parser. Untrusted TeX cannot create links/images/HTML.
			const template = document.createElement("template");
			template.innerHTML = renderToString(source, {
				output: "mathml",
				displayMode: display,
				trust: false,
				strict: "error",
				throwOnError: true,
				maxExpand: 200,
				maxSize: 20,
			});
			for (const child of template.content.querySelectorAll("*")) {
				for (const attribute of [...child.attributes])
					if (/^(?:on|href|src|style)/i.test(attribute.name)) child.removeAttribute(attribute.name);
			}
			node.append(template.content);
		} catch {
			node.textContent = source;
			node.title = "Formula could not be typeset; showing its exact source.";
		}
		return node;
	}

	function code(source: string, language: string): HTMLElement {
		const block = element("section", "message-code");
		const toolbar = element("div", "code-toolbar");
		const copy = element("button", "button button-quiet", "Copy");
		copy.type = "button";
		copy.setAttribute("aria-label", `Copy ${language || "plain text"} code`);
		copy.addEventListener("click", async () => {
			try {
				await document.defaultView!.navigator.clipboard.writeText(source);
				copy.textContent = "Copied";
			} catch {
				copy.textContent = "Copy failed";
				copy.title = "Clipboard access is unavailable. Select and copy the code manually.";
			}
		});
		toolbar.append(element("span", undefined, language || "text"), copy);
		const pre = element("pre", "code-lines");
		pre.tabIndex = 0;
		pre.setAttribute("aria-label", `${language || "Plain text"} code`);
		const lines: HTMLElement[] = [];
		let current: HTMLElement;
		function nextLine(): void {
			const line = element("span", "code-line");
			const number = element("span", "code-number", String(lines.length + 1));
			number.setAttribute("aria-hidden", "true");
			current = element("code", "code-source");
			line.append(number, current);
			lines.push(line);
			pre.append(line);
		}
		nextLine();
		function appendText(value: string, classes: string[]): void {
			for (const [index, part] of value.split("\n").entries()) {
				if (index) nextLine();
				if (classes.length) current.append(element("span", classes.join(" "), part));
				else current.append(document.createTextNode(part));
			}
		}
		if (language && hljs.getLanguage(language)) {
			const template = document.createElement("template");
			template.innerHTML = hljs.highlight(source, { language, ignoreIllegals: true }).value;
			function visit(node: Node, classes: string[] = []): void {
				if (node.nodeType === 3) appendText(node.textContent ?? "", classes);
				else {
					const next =
						node.nodeType === 1
							? [
									...classes,
									...[...(node as Element).classList].filter((name) => /^[a-zA-Z_][\w-]*$/.test(name)),
								]
							: classes;
					for (const child of node.childNodes) visit(child, next);
				}
			}
			visit(template.content);
		} else appendText(source, []);
		for (const line of lines) {
			const value = line.querySelector("code")!.textContent ?? "";
			if (language === "diff") {
				if (value.startsWith("+")) line.classList.add("code-diff-add");
				if (value.startsWith("-")) line.classList.add("code-diff-remove");
			}
		}
		block.append(toolbar, pre);
		if (lines.length > 12) {
			const expand = element("button", "button button-quiet", `Show all ${lines.length} lines`);
			expand.type = "button";
			expand.setAttribute("aria-expanded", "false");
			for (const line of lines.slice(12)) line.hidden = true;
			expand.addEventListener("click", () => {
				const open = expand.getAttribute("aria-expanded") !== "true";
				expand.setAttribute("aria-expanded", String(open));
				expand.textContent = open ? "Collapse output" : `Show all ${lines.length} lines`;
				for (const line of lines.slice(12)) line.hidden = !open;
			});
			block.append(expand);
		}
		return block;
	}

	function append(target: HTMLElement, tokens: Token[], depth = 0): void {
		for (const value of tokens) {
			if (depth > 50) {
				target.append(document.createTextNode(value.raw));
				continue;
			}
			if (value.type === "math") {
				target.append(math(String(value.text), value.display === true));
				continue;
			}
			const token = value as MarkedToken;
			switch (token.type) {
				case "space":
				case "def":
					break;
				case "code":
					target.append(code(token.text, token.lang?.split(/\s/)[0].toLowerCase() ?? ""));
					break;
				case "heading": {
					const heading = element(`h${Math.min(6, token.depth + 1)}` as "h2");
					append(heading, token.tokens, depth + 1);
					target.append(heading);
					break;
				}
				case "paragraph":
				case "blockquote":
				case "strong":
				case "em":
				case "del": {
					const node = element(token.type === "paragraph" ? "p" : token.type);
					append(node, token.tokens, depth + 1);
					target.append(node);
					break;
				}
				case "list": {
					const list = element(token.ordered ? "ol" : "ul");
					if (token.ordered && typeof token.start === "number") list.setAttribute("start", String(token.start));
					for (const item of token.items) {
						const row = element("li");
						if (item.task) {
							const check = element("input");
							check.type = "checkbox";
							check.checked = !!item.checked;
							check.disabled = true;
							check.setAttribute("aria-label", item.checked ? "Completed" : "Not completed");
							row.append(check);
						}
						append(row, item.tokens, depth + 1);
						list.append(row);
					}
					target.append(list);
					break;
				}
				case "table": {
					const scroll = element("div", "message-table table-scroll");
					scroll.tabIndex = 0;
					scroll.setAttribute("role", "region");
					scroll.setAttribute("aria-label", "Assistant data table");
					const table = element("table");
					const head = element("thead");
					const body = element("tbody");
					for (const [index, cells] of [token.header, ...token.rows].entries()) {
						const row = element("tr");
						for (const [column, cell] of cells.entries()) {
							const node = element(index ? "td" : "th");
							if (!index) node.setAttribute("scope", "col");
							if (token.align[column] === "right") node.classList.add("numeric");
							append(node, cell.tokens, depth + 1);
							row.append(node);
						}
						(index ? body : head).append(row);
					}
					table.append(head, body);
					scroll.append(table);
					target.append(scroll);
					break;
				}
				case "link": {
					// Only explicit web citations are navigable. Local paths and dangerous schemes remain text.
					if (/^https?:\/\//i.test(token.href) && !/[\u0000-\u0020]/u.test(token.href)) {
						const link = element("a", "message-citation");
						link.href = token.href;
						link.target = "_blank";
						link.rel = "noopener noreferrer";
						if (token.title) link.title = token.title;
						append(link, token.tokens, depth + 1);
						target.append(link);
					} else append(target, token.tokens, depth + 1);
					break;
				}
				case "image":
					target.append(element("span", "muted", `[Image: ${token.text}]`));
					break;
				case "codespan":
					target.append(element("code", undefined, token.text));
					break;
				case "br":
				case "hr":
					target.append(element(token.type));
					break;
				case "text":
					if (token.tokens) append(target, token.tokens, depth + 1);
					else target.append(document.createTextNode(token.text));
					break;
				default:
					target.append(document.createTextNode("text" in token ? token.text : token.raw));
			}
		}
	}

	try {
		append(container, markdown.lexer(text));
	} catch {
		container.replaceChildren(element("p", undefined, text));
	}
}
