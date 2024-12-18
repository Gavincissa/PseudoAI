'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';

//react markdown
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

//resizable panels
import { PanelGroup, Panel, PanelResizeHandle } from 'react-resizable-panels';

//code mirror
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { vscodeDark } from '@uiw/codemirror-theme-vscode';
import { EditorView } from '@codemirror/view';
import { indentUnit } from '@codemirror/language';

//python function calls for pyodide
import { pythonFunctionCalls } from '@/utils/codeExecutionUtils';

//clerk user
import { useUser } from '@clerk/nextjs';

export default function ProblemPage() {
    //fetching the problems
    const params = useParams();
    const [problem, setProblem] = useState(null);

    //user input state management for the ai chatbot
    const [userInput, setUserInput] = useState('');
    const [messages, setMessages] = useState([]);
    const [response, setResponse] = useState('');
    const [loading, setLoading] = useState(false);
    //state management for code editor
    const [code, setCode] = useState('');
    const [isRunning, setIsRunning] = useState(false);
    const [results, setResults] = useState(null);
    const [selectedLanguage, setSelectedLanguage] = useState('javascript');
    //state management for pyodide
    const [pyodide, setPyodide] = useState(null);
    //user for update user progress
    const { user } = useUser();

    useEffect(() => {
        if (selectedLanguage === 'python' && !pyodide) {
            const loadPyodide = async () => {
                const pyodideInstance = await window.loadPyodide({
                    indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.24.1/full/',
                });
                setPyodide(pyodideInstance);
            };
            loadPyodide();
        }
    }, [selectedLanguage, pyodide]);

    //language map for selecting language
    const languageMap = {
        javascript: javascript({ jsx: true }),
        python: python(),
        java: java(),
        cpp: cpp(),
    };

    useEffect(() => {
        if (problem && problem.starterCodes) {
            setCode(problem.starterCodes[selectedLanguage]);
        }
    }, [problem, selectedLanguage]);

    //fetch problems from mongodb
    useEffect(() => {
        if (params.id) {
            console.log('Fetching problem with ID:', params.id);
            fetch(`/api/problems/${params.id}`)
                .then((res) => {
                    console.log('Response status:', res.status);
                    return res.json();
                })
                .then((data) => {
                    console.log('Received data:', data);
                    setProblem(data);
                })
                .catch((error) => console.error('Error:', error));
        }
    }, [params.id]);

    //user input for chatbot
    const handleUserInput = async (e) => {
        e.preventDefault();
        if (userInput.trim()) {
            // Create a system message with instructions and problem context
            const systemMessage = {
                role: 'system',
                content: `You are a coding mentor helping with the problem "${problem?.title}". 
                     IMPORTANT: DO NOT provide direct solutions or complete code answers.
                     Instead:
                     1. Provide hints and guidance
                     2. Ask leading questions
                     3. Explain relevant concepts
                     4. Suggest approaches without giving the solution
                     5. If asked for the solution, remind the user that you can only provide hints
                     
                     Problem Context:
                     ${problem?.description}
                     Difficulty: ${problem?.difficulty}
                     Topics: ${problem?.topics}
                     Starter Code: ${problem?.starterCodes[selectedLanguage]}
                     User Code: ${code}
                     Language: ${selectedLanguage}`,
            };

            const userMessage = { role: 'user', content: userInput };
            setMessages((prevMessages) => [...prevMessages, userMessage]);
            setUserInput('');
            setLoading(true);

            try {
                const res = await fetch('/api/chat', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        messages: [...messages, systemMessage, userMessage],
                    }),
                });

                if (!res.ok) {
                    throw new Error(`HTTP error! status: ${res.status}`);
                }

                const data = await res.json();
                if (data && data.output) {
                    const aiMessage = {
                        role: 'assistant',
                        content: data.output,
                    };
                    setMessages((prevMessages) => [...prevMessages, aiMessage]);
                    setResponse(data.output);
                } else {
                    throw new Error('Received an empty or invalid response');
                }
            } catch (error) {
                console.error('Error:', error);
                setResponse('Something went wrong. Please try again.');
            }

            setLoading(false);
        }
    };

    //running code in the code editor
    const runCode = async () => {
        setIsRunning(true);
        setResults(null);

        try {
            if (selectedLanguage === 'javascript') {
                console.log('Sending code to API:', code);
                const res = await fetch('/api/code', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        code,
                        language: selectedLanguage,
                        problemId: problem.id,
                        testCases: problem.testCases,
                        difficulty: problem.difficulty,
                        userId: user?.id,
                    }),
                });

                const data = await res.json();
                console.log('Received response from API:', data);

                setResults(data.results);
            } else if (selectedLanguage === 'python' && pyodide) {
                const results = problem.testCases.map((testCase, index) => {
                    try {
                        const functionCall =
                            pythonFunctionCalls[problem.id] ||
                            pythonFunctionCalls.default;

                        pyodide.globals.set('input', testCase.input);
                        pyodide.runPython(functionCall(code));
                        const result = pyodide.globals.get('result');

                        const jsResult =
                            result instanceof pyodide.ffi.PyProxy
                                ? result.toJs()
                                : result;

                        return {
                            testCase: index + 1,
                            passed:
                                JSON.stringify(jsResult) ===
                                JSON.stringify(testCase.output),
                            input: testCase.input,
                            expected: testCase.output,
                            received: jsResult,
                        };
                    } catch (error) {
                        return {
                            testCase: index + 1,
                            passed: false,
                            error: error.message,
                            input: testCase.input,
                            expected: testCase.output,
                            received: null,
                        };
                    }
                });

                // Send results to backend for progress tracking
                const res = await fetch('/api/code', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        code,
                        language: selectedLanguage,
                        problemId: problem.id,
                        testCases: problem.testCases,
                        difficulty: problem.difficulty,
                        userId: user?.id,
                        results,
                    }),
                });

                const data = await res.json();
                setResults(results);
            }
        } catch (error) {
            console.error('Frontend error:', error);
            setResults([
                {
                    testCase: 'Error',
                    passed: false,
                    error: 'Failed to run code. Please try again.',
                },
            ]);
        } finally {
            setIsRunning(false);
        }
    };

    //generating pseudo code in the editor
    const generatePseudoCode = async () => {
        setLoading(true);
        try {
            // Create a system message specifically for pseudo code generation
            const systemMessage = {
                role: 'system',
                content: `You are a coding mentor helping with the problem "${problem?.title}". 
                         Generate clear, step-by-step pseudocode for this problem.
                         The pseudocode should be detailed enough to guide the solution but not give away the exact implementation.
                         
                         Problem Context:
                         ${problem?.description}
                         Difficulty: ${problem?.difficulty}
                         Topics: ${problem?.topics}
                         Language: ${selectedLanguage}`,
            };

            const userMessage = {
                role: 'user',
                content:
                    'Generate pseudocode for this problem. Make it clear and educational.',
            };

            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    messages: [systemMessage, userMessage],
                }),
            });

            if (!res.ok) {
                throw new Error(`HTTP error! status: ${res.status}`);
            }

            const data = await res.json();
            if (data && data.output) {
                // Format the pseudo code as a multi-line comment based on the language
                const commentPrefix =
                    selectedLanguage === 'python' ? '#' : '//';
                const pseudoCode = `/*\nPSEUDO CODE:\n${data.output
                    .split('\n')
                    .map((line) => line.trim())
                    .join('\n')}\n*/\n\n${code}`;

                setCode(pseudoCode);
            }
        } catch (error) {
            console.error('Error generating pseudo code:', error);
        }
        setLoading(false);
    };

    return (
        <div className="h-[100vh] bg-gray-800 overflow-y-auto">
            <PanelGroup
                direction="horizontal"
                className="flex bg-gray-800 h-screen"
            >
                {/* Problem Section */}
                <Panel
                    defaultSize={25}
                    minSize={20}
                    className="w-1/4 bg-gray-800 text-gray-200 p-6 overflow-y-auto"
                >
                    <Link
                        className="text-blue-500 hover:underline"
                        href="/problems"
                    >
                        Back to Problems
                    </Link>
                    {problem ? (
                        <>
                            <h2 className="text-2xl font-bold">
                                {problem.title}
                            </h2>
                            <div className="flex gap-2 mt-2">
                                <span className="text-sm bg-blue-500 px-2 py-1 rounded">
                                    {problem.difficulty}
                                </span>
                                <span className="text-sm bg-purple-500 px-2 py-1 rounded">
                                    {problem.topics}
                                </span>
                            </div>
                            <p className="mt-4">{problem.description}</p>
                            <h3 className="mt-6 font-semibold">Constraints:</h3>
                            <ul className="list-disc list-inside mt-2">
                                {problem?.constraints?.map(
                                    (constraint, idx) => (
                                        <li key={idx}>{constraint}</li>
                                    )
                                )}
                            </ul>
                            <h3 className="mt-6 font-semibold">Examples:</h3>
                            {problem?.examples?.map((example, idx) => (
                                <pre
                                    key={idx}
                                    className="bg-gray-700 p-4 rounded mt-2 whitespace-pre-wrap break-words max-w-full overflow-x-hidden text-left"
                                >
                                    Input: {example.input}
                                    <br />
                                    Output: {example.output}
                                </pre>
                            ))}
                        </>
                    ) : (
                        <div>Loading problem...</div>
                    )}
                </Panel>

                <PanelResizeHandle className="w-[1px] bg-gray-700" />

                {/* Code Editor Section */}
                <Panel
                    defaultSize={50}
                    minSize={30}
                    className="w-[50vw] bg-gray-800 p-6 overflow-y-auto"
                >
                    <div className="flex justify-between items-center mb-4">
                        <h2 className="text-xl font-bold text-purple-400">
                            Code Editor
                        </h2>
                        <select
                            value={selectedLanguage}
                            onChange={(e) =>
                                setSelectedLanguage(e.target.value)
                            }
                            className="bg-gray-700 text-gray-200 px-3 py-1.5 rounded border border-gray-600 
                                 focus:outline-none focus:ring-2 focus:ring-purple-500"
                        >
                            <option value="javascript">JavaScript</option>
                            <option value="python">Python</option>
                        </select>
                    </div>
                    <CodeMirror
                        value={code}
                        height="50vh"
                        theme={vscodeDark}
                        extensions={[languageMap[selectedLanguage]]}
                        onChange={(value) => setCode(value)}
                        className="overflow-hidden text-black rounded-lg border border-gray-700"
                        basicSetup={{
                            lineNumbers: true,
                            highlightActiveLineGutter: true,
                            highlightSpecialChars: true,
                            history: true,
                            foldGutter: true,
                            drawSelection: true,
                            dropCursor: true,
                            allowMultipleSelections: true,
                            indentOnInput: true,
                            syntaxHighlighting: true,
                            bracketMatching: true,
                            closeBrackets: true,
                            autocompletion: true,
                            rectangularSelection: true,
                            crosshairCursor: true,
                            highlightActiveLine: true,
                            highlightSelectionMatches: true,
                            closeBracketsKeymap: true,
                            defaultKeymap: true,
                            searchKeymap: true,
                            historyKeymap: true,
                            foldKeymap: true,
                            completionKeymap: true,
                            lintKeymap: true,
                        }}
                        style={{
                            fontSize: '14px',
                            backgroundColor: '#1e1e1e',
                        }}
                    />
                    <div className="flex gap-2 mt-4">
                        <button
                            onClick={runCode}
                            disabled={isRunning}
                            className="flex-1 bg-purple-700 text-white px-6 py-2.5 rounded shadow 
                     hover:bg-purple-600 transition disabled:opacity-50 
                     font-medium text-sm"
                        >
                            {isRunning ? (
                                <span className="flex items-center justify-center gap-2">
                                    <svg
                                        className="animate-spin h-5 w-5"
                                        viewBox="0 0 24 24"
                                    >
                                        <circle
                                            className="opacity-25"
                                            cx="12"
                                            cy="12"
                                            r="10"
                                            stroke="currentColor"
                                            strokeWidth="4"
                                            fill="none"
                                        />
                                        <path
                                            className="opacity-75"
                                            fill="currentColor"
                                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                                        />
                                    </svg>
                                    Running...
                                </span>
                            ) : (
                                'Run Code'
                            )}
                        </button>
                        <button
                            onClick={generatePseudoCode}
                            className="px-4 py-2.5 rounded bg-blue-600 text-white hover:bg-blue-500 transition text-sm font-medium"
                        >
                            {loading ? 'Thinking...' : 'Generate Pseudo Code'}
                        </button>
                        <button
                            onClick={() =>
                                setCode(problem?.starterCodes[selectedLanguage])
                            }
                            className="px-4 py-2.5 rounded border border-gray-600 text-gray-300 
                     hover:bg-gray-700 transition text-sm font-medium"
                        >
                            Reset Code
                        </button>
                    </div>

                    {/* Test Results */}
                    {results && (
                        <div className="mt-4 bg-gray-900 p-4 rounded-lg overflow-y-auto max-h-[37vh]">
                            <h3 className="text-lg font-semibold text-purple-400 mb-2">
                                Test Results
                            </h3>
                            {results.map((result, index) => (
                                <div
                                    key={index}
                                    className={`p-2 mb-2 rounded ${
                                        result.passed
                                            ? 'bg-green-900/50 text-green-200'
                                            : 'bg-red-900/50 text-red-200'
                                    }`}
                                >
                                    <div className="font-semibold flex items-center gap-2">
                                        <span>
                                            Test Case {result.testCase}:
                                        </span>
                                        {result.passed ? (
                                            <span className="text-green-400">
                                                ✓ Passed
                                            </span>
                                        ) : (
                                            <span className="text-red-400">
                                                ✗ Failed
                                            </span>
                                        )}
                                    </div>
                                    {!result.passed && (
                                        <div className="text-sm mt-1">
                                            {result.error ? (
                                                <div className="text-red-300">
                                                    Error: {result.error}
                                                </div>
                                            ) : (
                                                <>
                                                    <div>
                                                        Input:{' '}
                                                        {JSON.stringify(
                                                            result.input
                                                        )}
                                                    </div>
                                                    <div>
                                                        Expected:{' '}
                                                        {JSON.stringify(
                                                            result.expected
                                                        )}
                                                    </div>
                                                    <div>
                                                        Received:{' '}
                                                        {JSON.stringify(
                                                            result.received
                                                        )}
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </Panel>

                <PanelResizeHandle className="w-[1px] bg-gray-700" />

                {/* AI Chat Section */}
                <Panel
                    defaultSize={25}
                    minSize={20}
                    className="w-1/4 bg-gray-800 p-6 flex flex-col overflow-y-auto"
                >
                    <h2 className="text-xl font-bold text-purple-400">
                        AI Assistant
                    </h2>
                    <div className="flex-grow mt-4 overflow-y-auto bg-gray-900 p-4 rounded border border-gray-700">
                        {messages.map((message, index) =>
                            message.role === 'user' ||
                            message.role === 'assistant' ? (
                                <div
                                    key={index}
                                    className={`mb-4 ${
                                        message.role === 'user'
                                            ? 'text-blue-400'
                                            : 'text-gray-300'
                                    }`}
                                >
                                    <div className="font-bold mb-1">
                                        {message.role === 'user'
                                            ? 'You:'
                                            : 'AI Assistant:'}
                                    </div>
                                    <ReactMarkdown
                                        className="prose prose-invert max-w-none"
                                        remarkPlugins={[remarkGfm, remarkMath]}
                                        rehypePlugins={[rehypeKatex]}
                                        components={{
                                            code({
                                                node,
                                                inline,
                                                className,
                                                children,
                                                ...props
                                            }) {
                                                return (
                                                    <code
                                                        className={`${className} bg-gray-800 rounded px-1`}
                                                        {...props}
                                                    >
                                                        {children}
                                                    </code>
                                                );
                                            },
                                            pre({ node, children, ...props }) {
                                                return (
                                                    <pre
                                                        className="bg-gray-800 p-4 rounded-lg overflow-x-auto"
                                                        {...props}
                                                    >
                                                        {children}
                                                    </pre>
                                                );
                                            },
                                        }}
                                    >
                                        {message.content}
                                    </ReactMarkdown>
                                </div>
                            ) : null
                        )}
                        {loading && (
                            <div className="text-gray-300 flex items-center gap-2">
                                <span className="font-bold">AI Assistant:</span>
                                <div className="flex items-center">
                                    <span>Thinking</span>
                                    <span className="ml-1 animate-pulse">
                                        ...
                                    </span>
                                </div>
                            </div>
                        )}
                        {messages.length === 0 && (
                            <p className="text-gray-400">
                                Ask for hints or pseudocode here.
                            </p>
                        )}
                    </div>
                    <form onSubmit={handleUserInput} className="mt-4">
                        <input
                            type="text"
                            value={userInput}
                            onChange={(e) => setUserInput(e.target.value)}
                            className="w-full p-2 rounded border border-gray-700 text-gray-200 bg-gray-800"
                            placeholder="Ask something..."
                        />
                        <button
                            type="submit"
                            className="mt-2 w-full bg-purple-700 text-white px-4 py-2 rounded shadow hover:bg-purple-600 transition"
                        >
                            {loading ? 'Thinking...' : 'Send'}
                        </button>
                    </form>
                </Panel>
            </PanelGroup>
        </div>
    );
}
