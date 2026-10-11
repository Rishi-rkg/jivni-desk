export const ErrorMessage = ({ message }: { message: string }) =>
  message ? (
    <div className="error" role="alert">
      {message}
    </div>
  ) : null;

/** The J+ mark and the name, wherever the application introduces itself. */
export const Brand = () => (
  <>
    <img className="brand-logo" src="/logo.svg" alt="" />
    Jivni
  </>
);
