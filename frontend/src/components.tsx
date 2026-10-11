export const ErrorMessage = ({ message }: { message: string }) =>
  message ? (
    <div className="error" role="alert">
      {message}
    </div>
  ) : null;
