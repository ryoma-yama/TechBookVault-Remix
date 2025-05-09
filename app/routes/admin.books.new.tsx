import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/cloudflare";
import { Form, useActionData, useFetcher } from "@remix-run/react";
import { eq } from "drizzle-orm";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { authors, bookAuthors, books } from "~/db/schema";
import { writeAuditLog } from "~/lib/audit";
import { requireAdminUser } from "~/lib/auth";
import { fetchBookInfoByISBN, getGoogleBooksCoverUrl } from "~/lib/google-books";
import { convertHtmlToMarkdown } from "~/lib/html-to-markdown.server";
import { renderMarkdownToHtml } from "~/lib/markdown-to-html.server";

const insertBookSchema = z.object({
  googleId: z.string().optional(),
  isbn13: z.string().length(13),
  title: z.string(),
  publisher: z.string().optional(),
  publishedDate: z.string().optional(),
  description: z.string().optional(),
});

export const meta: MetaFunction = () => {
  return [{ title: "書籍登録 | BookVault" }];
};

export async function loader({ request, context }: LoaderFunctionArgs) {
  const { db } = await requireAdminUser(request, context);

  const url = new URL(request.url);
  const isbn = url.searchParams.get("isbn");
  if (!isbn) return Response.json(null);

  const existing = await db.select().from(books).where(eq(books.isbn13, isbn)).get();
  if (existing) {
    return Response.json(
      { error: "このISBNはすでに登録されています", isDuplicate: true },
      { status: 409 }
    );
  }

  const apiKey = context.cloudflare.env.GOOGLE_BOOKS_API_KEY;
  const data = await fetchBookInfoByISBN(isbn, apiKey);

  if (!data) return Response.json(null)

  if (data.description) {
    data.description = await renderMarkdownToHtml(data.description);
  }

  return Response.json({
    ...data,
    authors: data.authors ?? [],
  });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const { db, user } = await requireAdminUser(request, context);

  const formData = await request.formData();
  const raw = Object.fromEntries(formData);
  const parsed = insertBookSchema.extend({
    authors: z.string().optional(),
  }).safeParse(raw);

  if (!parsed.success) {
    return Response.json({ errors: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { googleId, isbn13, title, publisher, publishedDate, description, authors: authorsRaw } = parsed.data;

  const inserted = await db
    .insert(books)
    .values({
      googleId,
      isbn13,
      title,
      publisher: publisher ?? "",
      publishedDate: publishedDate ?? "",
      description: convertHtmlToMarkdown(description ?? ""),
    })
    .returning({ id: books.id });

  const bookId = inserted[0].id;

  if (authorsRaw) {
    const authorList = authorsRaw
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);

    for (const name of authorList) {
      const existing = await db.select().from(authors).where(eq(authors.name, name)).get();
      const authorId = existing?.id ?? (
        await db.insert(authors).values({ name }).returning({ id: authors.id })
      )[0].id;

      await db.insert(bookAuthors).values({ bookId, authorId });
    }
  }

  await writeAuditLog({
    db,
    userId: user.id,
    actionType: "create_book",
    detail: {
      entity: "book",
      action: "create",
      data: { googleId, isbn13, title },
    },
  });

  return new Response(null, {
    status: 302,
    headers: { Location: "/books" },
  });
}

export default function BookNewPage() {
  const actionData = useActionData() as { errors?: Record<string, string[]> };
  const fetcher = useFetcher();
  const [isbn, setIsbn] = useState("");
  const [scanning, setScanning] = useState(false);
  const scannerRef = useRef<HTMLDivElement>(null);

  type BookData = {
    googleId: string;
    isbn13?: string;
    title: string;
    publisher?: string;
    publishedDate?: string;
    description?: string;
    authors?: string[];
  };

  const raw = fetcher.data;
  const book: BookData | null =
    raw && typeof raw === "object" && "googleId" in raw ? (raw as BookData) : null;

  const handleIsbnSearch = useCallback(() => {
    if (isbn.trim()) {
      fetcher.load(`/admin/books/new?isbn=${encodeURIComponent(isbn)}`);
    }
  }, [isbn, fetcher]);

  useEffect(() => {
    if (fetcher.state === "idle") {
      if (fetcher.data === null) {
        toast.error("書籍情報が見つかりませんでした");
      } else if (typeof fetcher.data === "object" && "error" in fetcher.data) {
        toast.error(fetcher.data.error as string);
      }
    }
  }, [fetcher.state, fetcher.data]);

  useEffect(() => {
    if (!scanning || !scannerRef.current) return;

    let scanner: import("html5-qrcode").Html5Qrcode | null = null;
    let isStarted = false;

    const startScanner = async () => {
      const { Html5Qrcode } = await import("html5-qrcode");
      scanner = new Html5Qrcode(scannerRef.current!.id);

      try {
        await scanner.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          (decodedText: string) => {
            if (/^\d{13}$/.test(decodedText) && scanner) {
              void scanner.stop().then(() => {
                isStarted = false;
                setIsbn(decodedText);
                setScanning(false);
                handleIsbnSearch();
              });
            }
          },
          () => { }
        );
        isStarted = true;
      } catch (err) {
        console.error("Scanner error:", err);
        setScanning(false);
      }
    };

    startScanner();

    return () => {
      if (scanner && isStarted) {
        scanner.stop().catch(() => { });
      }
    };
  }, [scanning, handleIsbnSearch]);

  const coverUrl = book?.googleId ? getGoogleBooksCoverUrl(book.googleId) : "";

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">書籍の新規登録</h1>
      <p className="text-sm text-gray-500">
        書籍のISBNを入力してください。Google Books APIから書籍情報を取得します。
        <br />
        書籍情報を確認後、登録ボタンを押してください。
      </p>
      <Form method="post" className="space-y-4">
        <div className="flex gap-2 items-end">
          <div>
            <Label htmlFor="isbn13">ISBN (13桁)</Label>
            <Input
              id="isbn13"
              name="isbn13"
              value={isbn}
              onChange={(e) => {
                const raw = e.target.value;
                if (/^\d{0,13}$/.test(raw)) {
                  setIsbn(raw);
                }
              }}
              required
              maxLength={13}
              inputMode="numeric"
              className="w-[17ch]"
            />
            {actionData?.errors?.isbn13 && (
              <p className="text-sm text-red-500">
                {actionData.errors.isbn13.join(", ")}
              </p>
            )}
          </div>
          <Button type="button" onClick={handleIsbnSearch} disabled={isbn.length !== 13}>
            検索
          </Button>
          <Button type="button" variant="outline" onClick={() => setScanning(true)}>
            カメラで読み取る
          </Button>
        </div>

        {scanning && (
          <div className="fixed inset-0 z-50 bg-black bg-opacity-80 flex flex-col items-center justify-center">
            <div className="text-white mb-2">カメラをISBNバーコードに向けてください</div>
            <div id="isbn-scanner" ref={scannerRef} className="w-[300px] h-[300px] bg-white" />
            <button onClick={() => setScanning(false)} className="mt-4 text-white underline">
              閉じる
            </button>
          </div>
        )}

        {book && (
          <input type="hidden" name="googleId" value={book.googleId} />
        )}

        <div className="space-y-2">
          <Label htmlFor="title">タイトル</Label>
          <Input id="title" name="title" defaultValue={book?.title ?? ""} required />
          {actionData?.errors?.title && (
            <p className="text-sm text-red-500">{actionData.errors.title.join(", ")}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="authors">著者（カンマ区切り）</Label>
          <Input
            id="authors"
            name="authors"
            defaultValue={book?.authors?.join(", ") ?? ""}
            placeholder="例：山田太郎, 佐藤花子"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="publisher">出版社</Label>
          <Input id="publisher" name="publisher" defaultValue={book?.publisher ?? ""} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="publishedDate">出版日</Label>
          <Input id="publishedDate" name="publishedDate" defaultValue={book?.publishedDate ?? ""} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="description">説明</Label>
          <Textarea
            id="description"
            name="description"
            defaultValue={book?.description ?? ""}
            rows={8}
          />
        </div>

        {book && coverUrl && (
          <img src={coverUrl} alt="書籍表紙" className="w-32 h-auto border rounded" />
        )}

        <Button type="submit" disabled={!isbn || isbn.length !== 13}>
          登録
        </Button>
      </Form>
    </div>
  )
}
